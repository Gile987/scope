// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HAR plugin implementation: records HTTP exchanges via a pluggable `HarWriter`
//! backend (local JSONL or Azure append blob), then serves HAR 1.2 JSON on
//! demand via the API.
//!
//! The writer backend is selected at startup based on gateway config:
//! - `har.blob` present → `BlobWriter` (streams to Azure append blob)
//! - `har.blob` absent  → `LocalWriter` (JSONL on pod-local disk)

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use parking_lot::RwLock;
use serde::Deserialize;
use tracing::debug;

use crate::plugin::{HttpExchange, ProxyPlugin, SessionId};

use super::storage::{BlobWriter, HarWriter, LocalWriter};
use super::writer;

/// Per-session metadata kept in the plugin (writer holds all data).
struct HarSession {
    redact: bool,
    finalized: bool,
    /// Set to true when the writer reports a hard failure (blob unreachable).
    /// The next `on_request` call will return an error, failing the run visibly.
    failed: bool,
    /// Current iteration number (starts at 1, bumped by rotate).
    current_iteration: u32,
}

/// Shared interior state cloned cheaply into Axum route handlers.
struct HarInner {
    sessions: RwLock<HashMap<SessionId, HarSession>>,
    writer: Arc<dyn HarWriter>,
}

impl HarInner {
    async fn build_har_for_session(&self, session_id: &SessionId, iteration: u32) -> Option<super::types::Har> {
        {
            let sessions = self.sessions.read();
            sessions.get(session_id)?;
        }
        let mut entries = self.writer.read_entries_async(session_id, iteration).await;
        // Sort by startedDateTime so concurrent appends appear chronologically.
        entries.sort_by(|a, b| a.started_date_time.cmp(&b.started_date_time));
        Some(writer::build_har(entries))
    }
}

/// HAR plugin — records HTTP exchanges via `HarWriter`, serves HAR via GET .../har.
pub struct HarPlugin {
    inner: Arc<HarInner>,
}

impl HarPlugin {
    /// Create using a `LocalWriter` (default — no blob config required).
    pub fn new(har_dir: std::path::PathBuf) -> Self {
        let writer = Arc::new(LocalWriter::new(har_dir));
        Self {
            inner: Arc::new(HarInner {
                sessions: RwLock::new(HashMap::new()),
                writer,
            }),
        }
    }

    /// Create using a `BlobWriter`.
    pub fn new_with_blob(
        container_client: azure_storage_blobs::prelude::ContainerClient,
        append_timeout: std::time::Duration,
    ) -> Self {
        let writer = Arc::new(BlobWriter::new(container_client, append_timeout));
        Self {
            inner: Arc::new(HarInner {
                sessions: RwLock::new(HashMap::new()),
                writer,
            }),
        }
    }
}

#[async_trait]
impl ProxyPlugin for HarPlugin {
    fn name(&self) -> &str {
        "har"
    }

    async fn on_session_start(&self, session_id: &SessionId, settings: &serde_json::Value) {
        let redact = settings
            .get("redactCredentials")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        self.inner.writer.init_session(session_id).await;

        let mut sessions = self.inner.sessions.write();
        sessions.insert(
            session_id.clone(),
            HarSession {
                redact,
                finalized: false,
                failed: false,
                current_iteration: 1,
            },
        );
        debug!("HAR plugin: session started for {}", session_id);
    }

    async fn on_exchange(&self, session_id: &SessionId, exchange: &HttpExchange) {
        let (redact, iteration) = {
            let sessions = self.inner.sessions.read();
            match sessions.get(session_id) {
                Some(s) if !s.finalized => (s.redact, s.current_iteration),
                _ => return,
            }
        };

        let entry = super::writer::exchange_to_har_entry(exchange, redact);
        self.inner.writer.append(session_id, iteration, &entry).await;

        // After the append, propagate a hard failure into the session so the
        // next on_request call can reject the run.
        if self.inner.writer.is_failed(session_id) {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.get_mut(session_id) {
                s.failed = true;
            }
        }
    }

    async fn on_request(
        &self,
        session_id: &SessionId,
        _uri: &http::Uri,
        _headers: &mut http::HeaderMap,
    ) -> anyhow::Result<()> {
        let failed = {
            let sessions = self.inner.sessions.read();
            sessions.get(session_id).map(|s| s.failed).unwrap_or(false)
        };
        if failed {
            anyhow::bail!(
                "HAR storage failure: blob append timed out for session {}; run aborted",
                session_id
            );
        }
        Ok(())
    }

    async fn on_session_stop(&self, session_id: &SessionId) {
        let mut sessions = self.inner.sessions.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.finalized = true;
            debug!("HAR plugin: session finalised for {}", session_id);
        }
    }

    async fn on_session_clear(&self, session_id: &SessionId) {
        {
            let mut sessions = self.inner.sessions.write();
            sessions.remove(session_id);
        }
        self.inner.writer.close_session(session_id);
        debug!("HAR plugin: session cleared for {}", session_id);
    }

    fn api_routes(&self) -> Option<axum::Router> {
        let inner = self.inner.clone();
        Some(
            axum::Router::new()
                .route("/har", get(get_har))
                .route("/har/rotate", post(post_rotate_har))
                .with_state(inner),
        )
    }
}

/// Query parameters for `GET /har`.
#[derive(Deserialize)]
struct HarQuery {
    /// Which iteration to return (required).
    iteration: u32,
}

/// GET /api/v1/sessions/:id/har?iteration=N — build and return HAR for an iteration.
async fn get_har(
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<HarQuery>,
    State(inner): State<Arc<HarInner>>,
) -> impl IntoResponse {
    match inner.build_har_for_session(&session_id, query.iteration).await {
        Some(har) => {
            let failed = inner.writer.is_failed(&session_id);
            let count = har.log.entries.len();
            debug!(
                "HAR plugin: returning {} entries for session {} iter {} (failed={})",
                count, session_id, query.iteration, failed
            );
            let body = serde_json::to_vec(&har).unwrap_or_default();
            let mut resp = axum::response::Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap();
            if failed {
                resp.headers_mut()
                    .insert("x-har-incomplete", HeaderValue::from_static("true"));
            }
            resp.into_response()
        }
        None => {
            debug!("HAR plugin: no data for session {}", session_id);
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// Query parameters for `POST /har/rotate`.
#[derive(Deserialize)]
struct RotateQuery {
    /// Expected current iteration (CAS guard).
    expected: u32,
}

/// JSON response for rotate.
#[derive(serde::Serialize)]
struct RotateResponse {
    iteration: u32,
}

/// POST /api/v1/sessions/:id/har/rotate?expected=N — rotate to a new iteration.
///
/// CAS semantics: if the session's current_iteration == expected, bump to
/// expected+1, init the new iteration file, and return 200 with the new
/// iteration number. If there's a mismatch, return 409 with the actual value.
async fn post_rotate_har(
    AxumPath(session_id): AxumPath<String>,
    Query(query): Query<RotateQuery>,
    State(inner): State<Arc<HarInner>>,
) -> impl IntoResponse {
    let current = {
        let sessions = inner.sessions.read();
        match sessions.get(&session_id) {
            Some(s) => s.current_iteration,
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };

    if current != query.expected {
        let body = serde_json::to_vec(&RotateResponse { iteration: current }).unwrap_or_default();
        return axum::response::Response::builder()
            .status(StatusCode::CONFLICT)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap()
            .into_response();
    }

    let new_iteration = query.expected + 1;

    // Init the new iteration file before updating the counter so writes
    // that arrive after the counter flip find the file ready.
    inner.writer.init_iteration(&session_id, new_iteration).await;

    {
        let mut sessions = inner.sessions.write();
        if let Some(s) = sessions.get_mut(&session_id) {
            s.current_iteration = new_iteration;
        }
    }

    debug!(
        "HAR plugin: rotated session {} from iter {} to {}",
        session_id, query.expected, new_iteration
    );

    let body = serde_json::to_vec(&RotateResponse { iteration: new_iteration }).unwrap_or_default();
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .unwrap()
        .into_response()
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

    #[tokio::test]
    async fn session_lifecycle() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_exchange(&sid, &make_exchange()).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 1);

        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 1);

        plugin.on_session_clear(&sid).await;
        assert!(plugin.inner.build_har_for_session(&sid, 1).await.is_none());
    }

    #[tokio::test]
    async fn redacts_headers_by_default() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({})).await;

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
        plugin.on_exchange(&sid, &exchange).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "[REDACTED]");
    }

    #[tokio::test]
    async fn preserves_headers_when_configured() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin
            .on_session_start(&sid, &serde_json::json!({"redactCredentials": false}))
            .await;

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
        plugin.on_exchange(&sid, &exchange).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        let auth = har.log.entries[0]
            .request
            .headers
            .iter()
            .find(|h| h.name == "authorization")
            .unwrap();
        assert_eq!(auth.value, "Bearer secret");
    }

    #[tokio::test]
    async fn restart_clears_previous_session() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();

        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_exchange(&sid, &make_exchange()).await;
        plugin.on_session_stop(&sid).await;

        // Restart — writer.init_session clears previous JSONL.
        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        plugin.on_session_stop(&sid).await;

        let har = plugin.inner.build_har_for_session(&sid, 1).await.unwrap();
        assert_eq!(har.log.entries.len(), 0);
    }

    #[tokio::test]
    async fn not_failed_for_local_writer() {
        let tmp = TempDir::new().unwrap();
        let plugin = HarPlugin::new(tmp.path().to_path_buf());
        let sid = "10.0.0.1".to_string();
        plugin.on_session_start(&sid, &serde_json::json!({})).await;
        assert!(!plugin.inner.writer.is_failed(&sid));
    }
}
