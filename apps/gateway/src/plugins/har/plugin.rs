// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR plugin implementation: records HTTP exchanges to append-only JSONL files
//! during active sessions, then builds HAR 1.2 JSON on-demand from the JSONL
//! when requested via the API.
//!
//! Design: JSONL (one JSON object per line) avoids holding all entries in memory.
//! Writes are append-only during the session; reads parse the file on each GET.
//! This trades read latency for memory efficiency — suitable for long sessions
//! with thousands of exchanges.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use parking_lot::RwLock;
use tracing::{debug, warn};

use crate::plugin::{HttpExchange, ProxyPlugin, SessionId};

use super::types::HarEntry;
use super::writer;

/// Per-session state tracked by the HAR plugin.
struct HarSession {
    jsonl_path: PathBuf,
    finalized: bool,
    redact: bool,
}

/// Shared interior state, cheaply cloneable via `Arc` so that the Axum route
/// handler can hold a reference without requiring `Arc<HarPlugin>` from the
/// outside. This lets `api_routes(&self)` work without `Arc<Self>`.
struct HarInner {
    har_dir: PathBuf,
    sessions: RwLock<HashMap<SessionId, HarSession>>,
}

impl HarInner {
    fn jsonl_path(&self, session_id: &SessionId) -> PathBuf {
        self.har_dir
            .join(format!(".session-{}.jsonl", session_id.replace(':', "_")))
    }

    fn build_har_for_session(&self, session_id: &SessionId) -> Option<super::types::Har> {
        let sessions = self.sessions.read();
        let session = sessions.get(session_id)?;

        let entries = self.read_jsonl_entries(&session.jsonl_path);
        Some(writer::build_har(entries))
    }

    fn read_jsonl_entries(&self, path: &Path) -> Vec<HarEntry> {
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
}

/// HAR plugin — records HTTP exchanges to JSONL, serves HAR via GET .../har.
pub struct HarPlugin {
    inner: Arc<HarInner>,
}

impl HarPlugin {
    /// Create a new HAR plugin that stores JSONL files in `har_dir`.
    pub fn new(har_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(HarInner {
                har_dir,
                sessions: RwLock::new(HashMap::new()),
            }),
        }
    }

    /// Extract HAR output directory from `defaultPluginSettings`.
    /// Falls back to `/tmp/scope-gateway/har-output` if not configured.
    pub fn output_dir_from_settings(
        settings: &HashMap<String, serde_json::Value>,
    ) -> PathBuf {
        settings
            .get("har")
            .and_then(|v| v.get("outputDir"))
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp/scope-gateway/har-output"))
    }
}

#[async_trait]
impl ProxyPlugin for HarPlugin {
    fn name(&self) -> &str {
        "har"
    }

    fn on_session_start(&self, session_id: &SessionId, settings: &serde_json::Value) {
        // Default to redacting sensitive headers (Authorization, cookies, API keys).
        // Callers must explicitly opt out with `"redactCredentials": false`.
        let redact = settings
            .get("redactCredentials")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let jsonl_path = self.inner.jsonl_path(session_id);

        // Clean up any leftover JSONL from a prior crash or un-cleared session.
        // Without this, a new session could inherit stale exchange data.
        let _ = std::fs::remove_file(&jsonl_path);

        // Create the har directory if needed
        if let Some(parent) = jsonl_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // Create empty JSONL file
        if let Err(e) = std::fs::File::create(&jsonl_path) {
            warn!(
                "Failed to create JSONL file {:?}: {}",
                jsonl_path, e
            );
        }

        let mut sessions = self.inner.sessions.write();
        sessions.insert(
            session_id.clone(),
            HarSession {
                jsonl_path,
                finalized: false,
                redact,
            },
        );

        debug!("HAR plugin: session started for {}", session_id);
    }

    fn on_exchange(&self, session_id: &SessionId, exchange: &HttpExchange) {
        let sessions = self.inner.sessions.read();
        let session = match sessions.get(session_id) {
            Some(s) if !s.finalized => s,
            // Finalized sessions still serve existing data via GET /har,
            // but we stop appending new exchanges after stop is called.
            _ => return,
        };

        let entry = writer::exchange_to_har_entry(exchange, session.redact);

        // Append JSON line to JSONL file
        match std::fs::OpenOptions::new()
            .append(true)
            .open(&session.jsonl_path)
        {
            Ok(mut file) => {
                if let Ok(json) = serde_json::to_string(&entry) {
                    let _ = writeln!(file, "{}", json);
                }
            }
            Err(e) => {
                warn!(
                    "Failed to append to JSONL {:?}: {}",
                    session.jsonl_path, e
                );
            }
        }
    }

    fn on_session_stop(&self, session_id: &SessionId) {
        let mut sessions = self.inner.sessions.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.finalized = true;
            debug!("HAR plugin: session finalized for {}", session_id);
        }
    }

    fn on_session_clear(&self, session_id: &SessionId) {
        let mut sessions = self.inner.sessions.write();
        if let Some(session) = sessions.remove(session_id) {
            let _ = std::fs::remove_file(&session.jsonl_path);
            debug!("HAR plugin: session cleared for {}", session_id);
        }
    }

    fn api_routes(&self) -> Option<axum::Router> {
        let inner = self.inner.clone();
        Some(
            axum::Router::new()
                .route("/har", get(get_har))
                .with_state(inner),
        )
    }
}

/// GET /api/v1/sessions/:id/har — build and return HAR from JSONL on the fly.
async fn get_har(
    AxumPath(session_id): AxumPath<String>,
    State(inner): State<Arc<HarInner>>,
) -> impl IntoResponse {
    match inner.build_har_for_session(&session_id) {
        Some(har) => {
            let count = har.log.entries.len();
            debug!("HAR plugin: returning {} entries for session {}", count, session_id);
            Json(har).into_response()
        }
        None => {
            debug!("HAR plugin: no data for session {}", session_id);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{ExchangeRequest, ExchangeResponse};
    use bytes::Bytes;
    use http::{HeaderMap, Method, Uri};
    use tempfile::TempDir;

    fn make_exchange() -> HttpExchange {
        HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: HeaderMap::new(),
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        }
    }

    #[test]
    fn session_lifecycle() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());

        let sid = "10.0.0.1".to_string();
        let settings = serde_json::json!({});

        // Start session
        plugin.on_session_start(&sid, &settings);
        assert!(plugin.inner.jsonl_path(&sid).exists());

        // Exchange
        let exchange = make_exchange();
        plugin.on_exchange(&sid, &exchange);

        // HAR available while active (returns entries so far)
        let har_active = plugin.inner.build_har_for_session(&sid).unwrap();
        assert_eq!(har_active.log.entries.len(), 1);

        // Stop session
        plugin.on_session_stop(&sid);

        // HAR still available after stop
        let har = plugin.inner.build_har_for_session(&sid).unwrap();
        assert_eq!(har.log.entries.len(), 1);

        // Idempotent — can read again
        let har2 = plugin.inner.build_har_for_session(&sid).unwrap();
        assert_eq!(har2.log.entries.len(), 1);

        // Clear deletes JSONL
        plugin.on_session_clear(&sid);
        assert!(!plugin.inner.jsonl_path(&sid).exists());
        assert!(plugin.inner.build_har_for_session(&sid).is_none());
    }

    #[test]
    fn redacts_headers_by_default() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());

        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({}));

        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret".parse().unwrap());

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: req_headers,
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        };

        plugin.on_exchange(&sid, &exchange);
        plugin.on_session_stop(&sid);

        let har = plugin.inner.build_har_for_session(&sid).unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "[REDACTED]");
    }

    #[test]
    fn preserves_headers_when_configured() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());

        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(
            &sid,
            &serde_json::json!({"redactCredentials": false}),
        );

        let mut req_headers = HeaderMap::new();
        req_headers.insert("authorization", "Bearer secret".parse().unwrap());

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://api.github.com/test"),
                headers: req_headers,
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 5,
            elapsed_ms: 10,
        };

        plugin.on_exchange(&sid, &exchange);
        plugin.on_session_stop(&sid);

        let har = plugin.inner.build_har_for_session(&sid).unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "Bearer secret");
    }

    #[test]
    fn restart_clears_previous_session() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());

        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({}));
        plugin.on_exchange(&sid, &make_exchange());
        plugin.on_session_stop(&sid);

        // Restart — should clear previous
        plugin.on_session_start(&sid, &serde_json::json!({}));
        plugin.on_session_stop(&sid);

        let har = plugin.inner.build_har_for_session(&sid).unwrap();
        assert_eq!(har.log.entries.len(), 0); // Previous entries cleared
    }
}
