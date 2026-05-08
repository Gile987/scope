// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR storage backends: local JSONL file or Azure append blob.
//!
//! `HarWriter` is the common async trait. `LocalWriter` is the original
//! JSONL-on-disk implementation, refactored to use `tokio::fs` for non-blocking
//! I/O. `BlobWriter` appends entries directly to an Azure append blob with
//! exponential-backoff retries bounded by a configurable timeout; if all retries
//! or the timeout fire, the session is marked hard-failed and the next proxied
//! request returns a 502.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use std::time::Duration;

use async_trait::async_trait;
use azure_storage_blobs::prelude::*;
use backon::{ExponentialBuilder, Retryable};
use tokio::io::AsyncWriteExt;
use tracing::{debug, warn};

use super::types::HarEntry;

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Backend-agnostic interface for per-session HAR entry storage.
///
/// Storage is organised by session and iteration:
///   `{root}/{session_id}/iter-{N}.jsonl`
///
/// A new iteration file is created when `init_iteration` is called.
#[async_trait]
pub trait HarWriter: Send + Sync {
    /// Serialize `entry` to JSONL and append it to the current iteration file.
    async fn append(&self, session_id: &str, iteration: u32, entry: &HarEntry);

    /// Read all entries for a specific iteration.
    fn read_entries(&self, session_id: &str, iteration: u32) -> Vec<HarEntry>;

    /// Async read variant — used by BlobWriter. Default delegates to `read_entries`.
    async fn read_entries_async(&self, session_id: &str, iteration: u32) -> Vec<HarEntry> {
        self.read_entries(session_id, iteration)
    }

    /// Returns `true` if a blob append permanently failed after all retries /
    /// timeout — the session is hard-failed and no further writes will succeed.
    fn is_failed(&self, session_id: &str) -> bool;

    /// Called when a session starts. Creates the session directory and the
    /// initial iteration file (iter-1).
    async fn init_session(&self, session_id: &str);

    /// Called when a new iteration begins. Creates the iteration file.
    async fn init_iteration(&self, session_id: &str, iteration: u32);

    /// Called when a session is stopped or cleared. Implementations should
    /// release per-session resources (remove directory, drop state).
    fn close_session(&self, session_id: &str);
}

// ---------------------------------------------------------------------------
// LocalWriter — JSONL on the pod's local filesystem
// ---------------------------------------------------------------------------

/// Per-session state for the local writer.
struct LocalSession {
    session_dir: PathBuf,
}

/// Writes HAR entries as JSONL lines to local disk using `tokio::fs`.
pub struct LocalWriter {
    har_dir: PathBuf,
    sessions: parking_lot::RwLock<std::collections::HashMap<String, LocalSession>>,
}

impl LocalWriter {
    pub fn new(har_dir: PathBuf) -> Self {
        Self {
            har_dir,
            sessions: parking_lot::RwLock::new(std::collections::HashMap::new()),
        }
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.har_dir
            .join(session_id.replace(':', "_"))
    }

    fn iter_path(&self, session_id: &str, iteration: u32) -> PathBuf {
        self.session_dir(session_id).join(format!("iter-{}.jsonl", iteration))
    }
}

#[async_trait]
impl HarWriter for LocalWriter {
    async fn init_session(&self, session_id: &str) {
        let session_dir = self.session_dir(session_id);

        // Clean up any leftover directory from a prior crash.
        let _ = tokio::fs::remove_dir_all(&session_dir).await;
        let _ = tokio::fs::create_dir_all(&session_dir).await;

        // Create iter-1 file.
        let path = self.iter_path(session_id, 1);
        if let Err(e) = tokio::fs::File::create(&path).await {
            warn!("HAR local: failed to create JSONL {:?}: {}", path, e);
        }

        let mut sessions = self.sessions.write();
        sessions.insert(
            session_id.to_string(),
            LocalSession {
                session_dir,
            },
        );
        debug!("HAR local: session initialised for {}", session_id);
    }

    async fn init_iteration(&self, session_id: &str, iteration: u32) {
        let path = self.iter_path(session_id, iteration);
        if let Err(e) = tokio::fs::File::create(&path).await {
            warn!("HAR local: failed to create iteration file {:?}: {}", path, e);
        }
        debug!("HAR local: iteration {} initialised for {}", iteration, session_id);
    }

    async fn append(&self, session_id: &str, iteration: u32, entry: &HarEntry) {
        let path = self.iter_path(session_id, iteration);

        let Ok(json) = serde_json::to_string(entry) else {
            return;
        };
        let line = format!("{}\n", json);

        match tokio::fs::OpenOptions::new().append(true).open(&path).await {
            Ok(mut file) => {
                if let Err(e) = file.write_all(line.as_bytes()).await {
                    warn!("HAR local: failed to append to {:?}: {}", path, e);
                } else if let Err(e) = file.sync_data().await {
                    warn!("HAR local: failed to sync {:?}: {}", path, e);
                }
            }
            Err(e) => {
                warn!("HAR local: failed to open {:?}: {}", path, e);
            }
        }
    }

    fn read_entries(&self, session_id: &str, iteration: u32) -> Vec<HarEntry> {
        let path = self.iter_path(session_id, iteration);
        read_jsonl_entries_sync(&path)
    }

    fn is_failed(&self, _session_id: &str) -> bool {
        false // local writes either succeed or warn; no hard-failure state
    }

    fn close_session(&self, session_id: &str) {
        let session_dir = {
            let mut sessions = self.sessions.write();
            sessions.remove(session_id).map(|s| s.session_dir)
        };
        if let Some(dir) = session_dir {
            // Best-effort cleanup — don't block on async in a sync context.
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// Synchronous JSONL reader (used on the API read path, not the hot write path).
pub fn read_jsonl_entries_sync(path: &Path) -> Vec<HarEntry> {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    std::io::BufReader::new(file)
        .lines()
        .filter_map(|line| {
            let line = line.ok()?;
            serde_json::from_str(&line).ok()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// BlobWriter — Azure append blob
// ---------------------------------------------------------------------------

/// Per-session state for the blob writer.
struct BlobSession {
    /// Set to true once an append permanently fails after all retries / timeout.
    /// Once set, the HAR plugin will reject the next proxied request with a 502.
    failed: Arc<AtomicBool>,
}

/// Writes HAR entries as JSONL lines to an Azure append blob.
///
/// Created once at gateway startup. `BlobServiceClient` is cheaply cloneable
/// and safe to use concurrently across sessions / Tokio tasks.
pub struct BlobWriter {
    container_client: ContainerClient,
    /// Hard ceiling on how long a single append (including all retries) may take.
    append_timeout: Duration,
    sessions: parking_lot::RwLock<std::collections::HashMap<String, BlobSession>>,
}

impl BlobWriter {
    pub fn new(container_client: ContainerClient, append_timeout: Duration) -> Self {
        Self {
            container_client,
            append_timeout,
            sessions: parking_lot::RwLock::new(std::collections::HashMap::new()),
        }
    }

    fn blob_name(session_id: &str, iteration: u32) -> String {
        format!("sessions/{}/iter-{}.jsonl", session_id, iteration)
    }

    /// Append `line` to the blob with exponential-backoff retries, bounded by
    /// `timeout`. Auth and not-found errors (401/403/404) are not retried.
    /// Returns `false` if all retries are exhausted or the timeout fires.
    async fn append_with_retry(blob_client: &BlobClient, line: String, timeout: Duration) -> bool {
        let bytes = bytes::Bytes::from(line);
        let retry_future = (|| async {
            blob_client
                .append_block(bytes.clone())
                .await
                .map_err(anyhow::Error::from)
        })
        .retry(
            ExponentialBuilder::default()
                .with_min_delay(Duration::from_millis(200))
                .with_max_delay(Duration::from_secs(5))
                .with_max_times(20),
        )
        .when(|e| {
            let msg = e.to_string();
            !msg.contains("401") && !msg.contains("403") && !msg.contains("404")
        });

        match tokio::time::timeout(timeout, retry_future).await {
            Ok(Ok(_)) => true,
            Ok(Err(_)) => false, // retries exhausted
            Err(_) => false,     // timeout fired
        }
    }
}

#[async_trait]
impl HarWriter for BlobWriter {
    async fn init_session(&self, session_id: &str) {
        let failed = Arc::new(AtomicBool::new(false));
        {
            let mut sessions = self.sessions.write();
            sessions.insert(
                session_id.to_string(),
                BlobSession {
                    failed: failed.clone(),
                },
            );
        }

        let blob_name = Self::blob_name(session_id, 1);
        let blob_client = self.container_client.blob_client(blob_name);

        // Create the append blob for iter-1. Idempotent — ignore "already exists" errors.
        match blob_client.put_append_blob().await {
            Ok(_) => {}
            Err(e) if e.to_string().contains("BlobAlreadyExists") => {}
            Err(e) => {
                warn!(
                    "HAR blob: failed to create append blob for session {}: {}",
                    session_id, e
                );
                failed.store(true, Ordering::Relaxed);
            }
        }
        debug!("HAR blob: session initialised for {}", session_id);
    }

    async fn init_iteration(&self, session_id: &str, iteration: u32) {
        let failed = {
            let sessions = self.sessions.read();
            sessions.get(session_id).map(|s| s.failed.clone())
        };

        let blob_name = Self::blob_name(session_id, iteration);
        let blob_client = self.container_client.blob_client(blob_name);

        match blob_client.put_append_blob().await {
            Ok(_) => {}
            Err(e) if e.to_string().contains("BlobAlreadyExists") => {}
            Err(e) => {
                warn!(
                    "HAR blob: failed to create append blob for session {} iter {}: {}",
                    session_id, iteration, e
                );
                if let Some(failed) = failed {
                    failed.store(true, Ordering::Relaxed);
                }
            }
        }
        debug!("HAR blob: iteration {} initialised for {}", iteration, session_id);
    }

    async fn append(&self, session_id: &str, iteration: u32, entry: &HarEntry) {
        let failed = {
            let sessions = self.sessions.read();
            match sessions.get(session_id) {
                Some(s) => s.failed.clone(),
                _ => return,
            }
        };

        // If the session is already hard-failed, skip further appends.
        if failed.load(Ordering::Relaxed) {
            return;
        }

        let Ok(json) = serde_json::to_string(entry) else {
            return;
        };
        let line = format!("{}\n", json);

        let blob_name = Self::blob_name(session_id, iteration);
        let blob_client = self.container_client.blob_client(blob_name);
        if !Self::append_with_retry(&blob_client, line, self.append_timeout).await {
            warn!(
                "HAR blob: all retries/timeout exhausted for session {}, marking hard-failed",
                session_id
            );
            failed.store(true, Ordering::Relaxed);
        }
    }

    fn read_entries(&self, _session_id: &str, _iteration: u32) -> Vec<HarEntry> {
        // BlobWriter overrides read_entries_async instead.
        Vec::new()
    }

    async fn read_entries_async(&self, session_id: &str, iteration: u32) -> Vec<HarEntry> {
        self.read_blob_entries(session_id, iteration).await
    }

    fn is_failed(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read();
        sessions
            .get(session_id)
            .map(|s| s.failed.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    fn close_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write();
        sessions.remove(session_id);
    }
}

impl BlobWriter {
    /// Read all JSONL entries for `session_id` iteration `iteration` from the append blob.
    /// Returns empty vec if the blob doesn't exist or can't be read.
    pub async fn read_blob_entries(&self, session_id: &str, iteration: u32) -> Vec<HarEntry> {
        let blob_name = Self::blob_name(session_id, iteration);
        let blob_client = self.container_client.blob_client(blob_name);

        let content = match blob_client.get_content().await {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "HAR blob: failed to read blob for session {}: {}",
                    session_id, e
                );
                return Vec::new();
            }
        };

        let text = match String::from_utf8(content) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };

        text.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // -----------------------------------------------------------------------
    // LocalWriter tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn local_writer_is_failed_always_false() {
        let dir = tempdir().unwrap();
        let writer = LocalWriter::new(dir.path().to_path_buf());
        writer.init_session("s1").await;
        assert!(!writer.is_failed("s1"));
        assert!(!writer.is_failed("unknown"));
    }

    #[tokio::test]
    async fn local_writer_round_trip() {
        let dir = tempdir().unwrap();
        let writer = LocalWriter::new(dir.path().to_path_buf());
        writer.init_session("s2").await;

        let entry = HarEntry {
            started_date_time: "2024-01-01T00:00:00Z".to_string(),
            time: 1.0,
            request: crate::plugins::har::types::HarRequest {
                method: "GET".to_string(),
                url: "https://example.com".to_string(),
                http_version: "HTTP/1.1".to_string(),
                cookies: vec![],
                headers: vec![],
                query_string: vec![],
                headers_size: -1,
                body_size: 0,
                post_data: None,
            },
            response: crate::plugins::har::types::HarResponse {
                status: 200,
                status_text: "OK".to_string(),
                http_version: "HTTP/1.1".to_string(),
                cookies: vec![],
                headers: vec![],
                content: crate::plugins::har::types::HarContent {
                    size: 0,
                    mime_type: "text/plain".to_string(),
                    text: None,
                    encoding: None,
                },
                headers_size: -1,
                body_size: 0,
                redirect_url: String::new(),
            },
            cache: crate::plugins::har::types::HarCache::default(),
            timings: crate::plugins::har::types::HarTimings {
                blocked: -1.0,
                dns: -1.0,
                connect: -1.0,
                send: 0.0,
                wait: 1.0,
                receive: 0.0,
                ssl: -1.0,
            },
        };

        writer.append("s2", 1, &entry).await;

        let entries = writer.read_entries("s2", 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].started_date_time, "2024-01-01T00:00:00Z");

        // Iteration 2 should be empty before init.
        assert!(writer.read_entries("s2", 2).is_empty());

        writer.close_session("s2");
        assert!(writer.read_entries("s2", 1).is_empty());
    }

    #[tokio::test]
    async fn local_writer_multi_iteration() {
        let dir = tempdir().unwrap();
        let writer = LocalWriter::new(dir.path().to_path_buf());
        writer.init_session("s-multi").await;

        let entry = HarEntry {
            started_date_time: "2024-01-01T00:00:00Z".to_string(),
            time: 1.0,
            request: crate::plugins::har::types::HarRequest {
                method: "GET".to_string(),
                url: "https://example.com/1".to_string(),
                http_version: "HTTP/1.1".to_string(),
                cookies: vec![],
                headers: vec![],
                query_string: vec![],
                headers_size: -1,
                body_size: 0,
                post_data: None,
            },
            response: crate::plugins::har::types::HarResponse {
                status: 200,
                status_text: "OK".to_string(),
                http_version: "HTTP/1.1".to_string(),
                cookies: vec![],
                headers: vec![],
                content: crate::plugins::har::types::HarContent {
                    size: 0,
                    mime_type: "text/plain".to_string(),
                    text: None,
                    encoding: None,
                },
                headers_size: -1,
                body_size: 0,
                redirect_url: String::new(),
            },
            cache: crate::plugins::har::types::HarCache::default(),
            timings: crate::plugins::har::types::HarTimings {
                blocked: -1.0,
                dns: -1.0,
                connect: -1.0,
                send: 0.0,
                wait: 1.0,
                receive: 0.0,
                ssl: -1.0,
            },
        };

        // Write to iter 1.
        writer.append("s-multi", 1, &entry).await;
        assert_eq!(writer.read_entries("s-multi", 1).len(), 1);

        // Start iter 2 and write to it.
        writer.init_iteration("s-multi", 2).await;
        let mut entry2 = entry.clone();
        entry2.request.url = "https://example.com/2".to_string();
        writer.append("s-multi", 2, &entry2).await;

        // Both iterations have independent entries.
        assert_eq!(writer.read_entries("s-multi", 1).len(), 1);
        assert_eq!(writer.read_entries("s-multi", 2).len(), 1);
        assert_eq!(writer.read_entries("s-multi", 1)[0].request.url, "https://example.com/1");
        assert_eq!(writer.read_entries("s-multi", 2)[0].request.url, "https://example.com/2");

        // close_session removes everything.
        writer.close_session("s-multi");
        assert!(writer.read_entries("s-multi", 1).is_empty());
        assert!(writer.read_entries("s-multi", 2).is_empty());
    }

    // -----------------------------------------------------------------------
    // BlobWriter degraded flag tests (no real Azure endpoint needed)
    // -----------------------------------------------------------------------

    fn fake_blob_writer() -> BlobWriter {
        let container_client = azure_storage_blobs::prelude::BlobServiceClient::new(
            "https://fake.blob.core.windows.net",
            azure_storage::StorageCredentials::anonymous(),
        )
        .container_client("test");
        BlobWriter::new(container_client, Duration::from_secs(120))
    }

    #[test]
    fn blob_writer_is_degraded_false_for_unknown_session() {
        let writer = fake_blob_writer();
        assert!(!writer.is_failed("nonexistent"));
    }

    #[test]
    fn blob_writer_is_degraded_true_after_flag_set() {
        let writer = fake_blob_writer();

        // Manually insert a session with failed=true to verify is_failed reads the flag.
        let failed_flag = Arc::new(AtomicBool::new(true));
        writer.sessions.write().insert(
            "s3".to_string(),
            BlobSession {
                failed: failed_flag,
            },
        );

        assert!(writer.is_failed("s3"));
    }

    #[test]
    fn blob_writer_is_degraded_false_when_flag_not_set() {
        let writer = fake_blob_writer();

        writer.sessions.write().insert(
            "s4".to_string(),
            BlobSession {
                failed: Arc::new(AtomicBool::new(false)),
            },
        );

        assert!(!writer.is_failed("s4"));
    }

    #[test]
    fn blob_writer_close_session_removes_state() {
        let writer = fake_blob_writer();

        writer.sessions.write().insert(
            "s5".to_string(),
            BlobSession {
                failed: Arc::new(AtomicBool::new(false)),
            },
        );

        writer.close_session("s5");
        assert!(writer.sessions.read().get("s5").is_none());
    }
}
