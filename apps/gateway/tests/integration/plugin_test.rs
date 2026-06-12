// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::helpers::TestGateway;
use gateway::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, ProxyPlugin, SessionId};
use tempfile::TempDir;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Custom test plugin that counts exchanges.
struct CounterPlugin {
    exchange_count: AtomicUsize,
}

impl CounterPlugin {
    fn new() -> Self {
        Self {
            exchange_count: AtomicUsize::new(0),
        }
    }

    fn count(&self) -> usize {
        self.exchange_count.load(Ordering::SeqCst)
    }
}

use async_trait::async_trait;

#[async_trait]
impl ProxyPlugin for CounterPlugin {
    fn name(&self) -> &str {
        "counter"
    }

    async fn on_session_start(&self, _session_id: &SessionId, _settings: &serde_json::Value) {}

    async fn on_exchange(
        &self,
        _session_id: &SessionId,
        _exchange: &HttpExchange,
        _iteration: u32,
    ) {
        self.exchange_count.fetch_add(1, Ordering::SeqCst);
    }

    async fn on_session_stop(&self, _session_id: &SessionId) {}

    async fn on_session_clear(&self, _session_id: &SessionId) {}

    fn api_routes(&self) -> Option<axum::Router> {
        None
    }
}

/// HAR plugin lifecycle: create → stop → GET .../har returns valid HAR.
#[tokio::test]
async fn har_plugin_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://example.com/*"]).await;

    let client = reqwest::Client::new();

    // Create session with HAR settings
    let session_id = uuid::Uuid::new_v4().to_string();
    let resp = client
        .post(gw.api_url("/api/v1/sessions"))
        .json(
            &serde_json::json!({"id": session_id, "plugins": {"har": {"redactCredentials": true}}}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);

    // Stop session
    let resp = client
        .post(gw.api_url(&format!("/api/v1/sessions/{}/stop", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Get HAR
    let resp = client
        .get(gw.api_url(&format!("/api/v1/sessions/{}/har?iteration=1", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let har: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(har["log"]["version"], "1.2");
    assert!(har["log"]["creator"]["name"].is_string());
}

/// Custom plugin implementing ProxyPlugin receives exchanges.
#[tokio::test]
async fn custom_plugin_receives_exchanges() {
    let counter = Arc::new(CounterPlugin::new());

    let registry = gateway::plugin::PluginRegistry::new(vec![counter.clone()]);

    let sid = "test-session".to_string();

    // Simulate session start
    let settings = std::collections::HashMap::new();
    registry.on_session_start(&sid, &settings).await;

    // Simulate exchange
    let exchange = HttpExchange {
        request: ExchangeRequest {
            method: http::Method::GET,
            uri: http::Uri::from_static("https://example.com/test"),
            headers: http::HeaderMap::new(),
            body: bytes::Bytes::new(),
        },
        response: ExchangeResponse {
            status: http::StatusCode::OK,
            headers: http::HeaderMap::new(),
            body: bytes::Bytes::from_static(b"ok"),
        },
        started_at: chrono::Utc::now(),
        wait_ms: 5,
        elapsed_ms: 10,
    };

    registry.on_exchange(&sid, &exchange, 1).await;
    registry.on_exchange(&sid, &exchange, 1).await;

    assert_eq!(counter.count(), 2);

    registry.on_session_stop(&sid).await;
}

/// Multiple plugins all receive the same exchanges.
#[tokio::test]
async fn multiple_plugins_receive_exchanges() {
    let counter1 = Arc::new(CounterPlugin::new());
    let counter2 = Arc::new(CounterPlugin::new());

    let registry = gateway::plugin::PluginRegistry::new(vec![counter1.clone(), counter2.clone()]);

    let sid = "test".to_string();

    let settings = std::collections::HashMap::new();
    registry.on_session_start(&sid, &settings).await;

    let exchange = HttpExchange {
        request: ExchangeRequest {
            method: http::Method::GET,
            uri: http::Uri::from_static("https://example.com/"),
            headers: http::HeaderMap::new(),
            body: bytes::Bytes::new(),
        },
        response: ExchangeResponse {
            status: http::StatusCode::OK,
            headers: http::HeaderMap::new(),
            body: bytes::Bytes::from_static(b"ok"),
        },
        started_at: chrono::Utc::now(),
        wait_ms: 2,
        elapsed_ms: 5,
    };

    registry.on_exchange(&sid, &exchange, 1).await;

    assert_eq!(counter1.count(), 1);
    assert_eq!(counter2.count(), 1);
}
