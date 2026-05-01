// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR storage backends: local JSONL file or Azure append blob.
//!
//! `HarWriter` is the common async trait. `LocalWriter` is the original
//! JSONL-on-disk implementation, refactored to use `tokio::fs` for non-blocking
//! I/O. `BlobWriter` appends entries directly to an Azure append blob with
//! exponential-backoff retries; failed retries set a per-session `degraded` flag
//! surfaced via `GET /har` as `X-HAR-Incomplete: true`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
#[async_trait]
pub trait HarWriter: Send + Sync {
    /// Serialize `entry` to JSONL and append it to the session's storage.
    async fn append(&self, session_id: &str, entry: &HarEntry);

    /// Read all entries written so far for `session_id`.
    fn read_entries(&self, session_id: &str) -> Vec<HarEntry>;

    /// Async read variant — used by BlobWriter. Default delegates to `read_entries`.
    async fn read_entries_async(&self, session_id: &str) -> Vec<HarEntry> {
        self.read_entries(session_id)
    }

    /// Returns `true` if at least one append has permanently failed after
    /// all retries — indicating the stored data may be incomplete.
    fn is_degraded(&self, session_id: &str) -> bool;

    /// Called when a session starts. Implementations should initialise any
    /// per-session state (create the file / append blob).
    async fn init_session(&self, session_id: &str);

    /// Called when a session is stopped or cleared. Implementations should
    /// release per-session resources (close file handles, drop state).
    fn close_session(&self, session_id: &str);
}

// ---------------------------------------------------------------------------
// LocalWriter — JSONL on the pod's local filesystem
// ---------------------------------------------------------------------------

/// Per-session state for the local writer.
struct LocalSession {
    jsonl_path: PathBuf,
    finalized: bool,
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

    fn jsonl_path(&self, session_id: &str) -> PathBuf {
        self.har_dir
            .join(format!(".session-{}.jsonl", session_id.replace(':', "_")))
    }
}

#[async_trait]
impl HarWriter for LocalWriter {
    async fn init_session(&self, session_id: &str) {
        let path = self.jsonl_path(session_id);

        // Clean up any leftover JSONL from a prior crash.
        let _ = tokio::fs::remove_file(&path).await;

        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        if let Err(e) = tokio::fs::File::create(&path).await {
            warn!("HAR local: failed to create JSONL {:?}: {}", path, e);
        }

        let mut sessions = self.sessions.write();
        sessions.insert(
            session_id.to_string(),
            LocalSession {
                jsonl_path: path,
                finalized: false,
            },
        );
        debug!("HAR local: session initialised for {}", session_id);
    }

    async fn append(&self, session_id: &str, entry: &HarEntry) {
        let path = {
            let sessions = self.sessions.read();
            match sessions.get(session_id) {
                Some(s) if !s.finalized => s.jsonl_path.clone(),
                _ => return,
            }
        };

        let Ok(json) = serde_json::to_string(entry) else {
            return;
        };
        let line = format!("{}\n", json);

        match tokio::fs::OpenOptions::new().append(true).open(&path).await {
            Ok(mut file) => {
                if let Err(e) = file.write_all(line.as_bytes()).await {
                    warn!("HAR local: failed to append to {:?}: {}", path, e);
                }
            }
            Err(e) => {
                warn!("HAR local: failed to open {:?}: {}", path, e);
            }
        }
    }

    fn read_entries(&self, session_id: &str) -> Vec<HarEntry> {
        let sessions = self.sessions.read();
        let Some(session) = sessions.get(session_id) else {
            return Vec::new();
        };
        read_jsonl_entries_sync(&session.jsonl_path)
    }

    fn is_degraded(&self, _session_id: &str) -> bool {
        false // local writes either succeed or warn; no persistent degraded state
    }

    fn close_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write();
        sessions.remove(session_id);
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
    /// Name of the append blob (e.g. `sessions/{sessionId}.jsonl`).
    blob_name: String,
    /// Set to true once any append permanently fails after all retries.
    degraded: Arc<AtomicBool>,
    finalized: bool,
}

/// Writes HAR entries as JSONL lines to an Azure append blob.
///
/// Created once at gateway startup. `BlobServiceClient` is cheaply cloneable
/// and safe to use concurrently across sessions / Tokio tasks.
pub struct BlobWriter {
    container_client: ContainerClient,
    sessions: parking_lot::RwLock<std::collections::HashMap<String, BlobSession>>,
}

impl BlobWriter {
    pub fn new(container_client: ContainerClient) -> Self {
        Self {
            container_client,
            sessions: parking_lot::RwLock::new(std::collections::HashMap::new()),
        }
    }

    fn blob_name(session_id: &str) -> String {
        format!("sessions/{}.jsonl", session_id)
    }

    /// Append `line` to the blob with exponential-backoff retries.
    /// Auth and not-found errors (401/403/404) are not retried.
    /// Returns `false` if all retries are exhausted (caller should set degraded).
    async fn append_with_retry(blob_client: &BlobClient, line: String) -> bool {
        let bytes = bytes::Bytes::from(line);
        let result = (|| async {
            blob_client
                .append_block(bytes.clone())
                .await
                .map_err(anyhow::Error::from)
        })
        .retry(
            ExponentialBuilder::default()
                .with_min_delay(std::time::Duration::from_millis(50))
                .with_max_delay(std::time::Duration::from_millis(500))
                .with_max_times(3),
        )
        .when(|e| {
            let msg = e.to_string();
            !msg.contains("401") && !msg.contains("403") && !msg.contains("404")
        })
        .await;

        result.is_ok()
    }
}

#[async_trait]
impl HarWriter for BlobWriter {
    async fn init_session(&self, session_id: &str) {
        let blob_name = Self::blob_name(session_id);
        let blob_client = self.container_client.blob_client(blob_name.clone());

        // Create the append blob. Idempotent — ignore "already exists" errors.
        match blob_client.put_append_blob().await {
            Ok(_) => {}
            Err(e) if e.to_string().contains("BlobAlreadyExists") => {}
            Err(e) => {
                warn!(
                    "HAR blob: failed to create append blob for session {}: {}",
                    session_id, e
                );
            }
        }

        let mut sessions = self.sessions.write();
        sessions.insert(
            session_id.to_string(),
            BlobSession {
                blob_name,
                degraded: Arc::new(AtomicBool::new(false)),
                finalized: false,
            },
        );
        debug!("HAR blob: session initialised for {}", session_id);
    }

    async fn append(&self, session_id: &str, entry: &HarEntry) {
        let (blob_name, degraded) = {
            let sessions = self.sessions.read();
            match sessions.get(session_id) {
                Some(s) if !s.finalized => (s.blob_name.clone(), s.degraded.clone()),
                _ => return,
            }
        };

        let Ok(json) = serde_json::to_string(entry) else {
            return;
        };
        let line = format!("{}\n", json);

        let blob_client = self.container_client.blob_client(blob_name);
        if !Self::append_with_retry(&blob_client, line).await {
            warn!(
                "HAR blob: all retries exhausted for session {}, marking degraded",
                session_id
            );
            degraded.store(true, Ordering::Relaxed);
        }
    }

    fn read_entries(&self, _session_id: &str) -> Vec<HarEntry> {
        // BlobWriter overrides read_entries_async instead.
        Vec::new()
    }

    async fn read_entries_async(&self, session_id: &str) -> Vec<HarEntry> {
        self.read_blob_entries(session_id).await
    }

    fn is_degraded(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read();
        sessions
            .get(session_id)
            .map(|s| s.degraded.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    fn close_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write();
        sessions.remove(session_id);
    }
}

impl BlobWriter {
    /// Read all JSONL entries for `session_id` from the append blob.
    /// Returns empty vec if the blob doesn't exist or can't be read.
    pub async fn read_blob_entries(&self, session_id: &str) -> Vec<HarEntry> {
        let blob_name = Self::blob_name(session_id);
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
    async fn local_writer_is_degraded_always_false() {
        let dir = tempdir().unwrap();
        let writer = LocalWriter::new(dir.path().to_path_buf());
        writer.init_session("s1").await;
        assert!(!writer.is_degraded("s1"));
        assert!(!writer.is_degraded("unknown"));
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

        writer.append("s2", &entry).await;

        let entries = writer.read_entries("s2");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].started_date_time, "2024-01-01T00:00:00Z");

        writer.close_session("s2");
        assert!(writer.read_entries("s2").is_empty());
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
        BlobWriter::new(container_client)
    }

    #[test]
    fn blob_writer_is_degraded_false_for_unknown_session() {
        let writer = fake_blob_writer();
        assert!(!writer.is_degraded("nonexistent"));
    }

    #[test]
    fn blob_writer_is_degraded_true_after_flag_set() {
        let writer = fake_blob_writer();

        // Manually insert a session with degraded=true to verify is_degraded reads the flag.
        let degraded_flag = Arc::new(AtomicBool::new(true));
        writer.sessions.write().insert(
            "s3".to_string(),
            BlobSession {
                blob_name: "sessions/s3.jsonl".to_string(),
                degraded: degraded_flag,
                finalized: false,
            },
        );

        assert!(writer.is_degraded("s3"));
    }

    #[test]
    fn blob_writer_is_degraded_false_when_flag_not_set() {
        let writer = fake_blob_writer();

        writer.sessions.write().insert(
            "s4".to_string(),
            BlobSession {
                blob_name: "sessions/s4.jsonl".to_string(),
                degraded: Arc::new(AtomicBool::new(false)),
                finalized: false,
            },
        );

        assert!(!writer.is_degraded("s4"));
    }

    #[test]
    fn blob_writer_close_session_removes_state() {
        let writer = fake_blob_writer();

        writer.sessions.write().insert(
            "s5".to_string(),
            BlobSession {
                blob_name: "sessions/s5.jsonl".to_string(),
                degraded: Arc::new(AtomicBool::new(false)),
                finalized: false,
            },
        );

        writer.close_session("s5");
        assert!(writer.sessions.read().get("s5").is_none());
    }
}
