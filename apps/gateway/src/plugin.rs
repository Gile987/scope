// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Plugin trait and broadcast registry for the proxy pipeline.
//!
//! The proxy core delegates all traffic observation to plugins via the
//! `ProxyPlugin` trait, keeping the proxy pipeline decoupled from recording,
//! analysis, or modification logic. All hooks are async — plugins may perform
//! I/O (blob appends, Redis writes) without blocking Tokio worker threads.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode, Uri};
use serde_json::Value;

/// Unique session identifier — source IP or X-Session-Id header value.
pub type SessionId = String;

/// A captured HTTP request/response pair passed to plugins.
#[derive(Debug, Clone)]
pub struct HttpExchange {
    pub request: ExchangeRequest,
    pub response: ExchangeResponse,
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// Time to first byte (headers received) in ms.
    pub wait_ms: u64,
    /// Total request duration (send + wait + receive) in ms.
    pub elapsed_ms: u64,
}

/// The request half of a captured HTTP exchange.
#[derive(Debug, Clone)]
pub struct ExchangeRequest {
    pub method: Method,
    pub uri: Uri,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// The response half of a captured HTTP exchange.
#[derive(Debug, Clone)]
pub struct ExchangeResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// Plugin trait — all traffic observation is handled by plugins.
/// The proxy core calls these hooks; plugins buffer/process internally.
#[async_trait]
pub trait ProxyPlugin: Send + Sync {
    /// Unique name (used in config and API routes).
    fn name(&self) -> &str;

    /// Called when a session starts.
    /// `settings` is the plugin-specific JSON from POST /session/start body.
    async fn on_session_start(&self, session_id: &SessionId, settings: &Value);

    /// Called before a request is forwarded upstream. Plugins may mutate headers
    /// (e.g. to refresh/inject credentials). Only called for intercepted sessions.
    /// Default implementation is a no-op.
    async fn on_request(
        &self,
        _session_id: &SessionId,
        _uri: &Uri,
        _headers: &mut HeaderMap,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Called for each intercepted request/response pair.
    async fn on_exchange(&self, session_id: &SessionId, exchange: &HttpExchange, iteration: u32);

    /// Called when a session stops (POST /session/stop).
    async fn on_session_stop(&self, session_id: &SessionId);

    /// Called when a session is reaped (idle timeout or next start).
    async fn on_session_clear(&self, session_id: &SessionId);

    /// Optional: register additional API routes.
    fn api_routes(&self) -> Option<axum::Router> {
        None
    }
}

/// Registry that broadcasts lifecycle events to all registered plugins.
pub struct PluginRegistry {
    plugins: Vec<Arc<dyn ProxyPlugin>>,
}

impl PluginRegistry {
    /// Create a registry with the given plugins.
    pub fn new(plugins: Vec<Arc<dyn ProxyPlugin>>) -> Self {
        Self { plugins }
    }

    /// Get a reference to the registered plugins.
    pub fn plugins(&self) -> &[Arc<dyn ProxyPlugin>] {
        &self.plugins
    }

    /// Notify all plugins that a session has started.
    pub async fn on_session_start(
        &self,
        session_id: &SessionId,
        plugin_settings: &HashMap<String, Value>,
    ) {
        // Plugins that aren't mentioned in the session's pluginSettings get an
        // empty JSON object, so they can apply their own defaults without None checks.
        let empty = Value::Object(serde_json::Map::new());
        for plugin in &self.plugins {
            let settings = plugin_settings.get(plugin.name()).unwrap_or(&empty);
            plugin.on_session_start(session_id, settings).await;
        }
    }

    /// Give all plugins a chance to mutate request headers before forwarding.
    pub async fn on_request(
        &self,
        session_id: &SessionId,
        uri: &Uri,
        headers: &mut HeaderMap,
    ) -> anyhow::Result<()> {
        for plugin in &self.plugins {
            plugin.on_request(session_id, uri, headers).await?;
        }
        Ok(())
    }

    /// Broadcast a captured exchange to all plugins.
    pub async fn on_exchange(&self, session_id: &SessionId, exchange: &HttpExchange, iteration: u32) {
        for plugin in &self.plugins {
            plugin.on_exchange(session_id, exchange, iteration).await;
        }
    }

    /// Notify all plugins that a session has stopped.
    pub async fn on_session_stop(&self, session_id: &SessionId) {
        for plugin in &self.plugins {
            plugin.on_session_stop(session_id).await;
        }
    }

    /// Notify all plugins that a session is being cleared (deleted or reaped).
    pub async fn on_session_clear(&self, session_id: &SessionId) {
        for plugin in &self.plugins {
            plugin.on_session_clear(session_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestPlugin {
        start_count: AtomicUsize,
        exchange_count: AtomicUsize,
        stop_count: AtomicUsize,
        clear_count: AtomicUsize,
    }

    impl TestPlugin {
        fn new() -> Self {
            Self {
                start_count: AtomicUsize::new(0),
                exchange_count: AtomicUsize::new(0),
                stop_count: AtomicUsize::new(0),
                clear_count: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ProxyPlugin for TestPlugin {
        fn name(&self) -> &str {
            "test"
        }

        async fn on_session_start(&self, _session_id: &SessionId, _settings: &Value) {
            self.start_count.fetch_add(1, Ordering::SeqCst);
        }

        async fn on_exchange(&self, _session_id: &SessionId, _exchange: &HttpExchange, _iteration: u32) {
            self.exchange_count.fetch_add(1, Ordering::SeqCst);
        }

        async fn on_session_stop(&self, _session_id: &SessionId) {
            self.stop_count.fetch_add(1, Ordering::SeqCst);
        }

        async fn on_session_clear(&self, _session_id: &SessionId) {
            self.clear_count.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn make_exchange() -> HttpExchange {
        HttpExchange {
            request: ExchangeRequest {
                method: Method::GET,
                uri: Uri::from_static("https://example.com/test"),
                headers: HeaderMap::new(),
                body: Bytes::new(),
            },
            response: ExchangeResponse {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"ok"),
            },
            started_at: chrono::Utc::now(),
            wait_ms: 10,
            elapsed_ms: 42,
        }
    }

    #[tokio::test]
    async fn registry_broadcasts_to_all_plugins() {
        let p1 = Arc::new(TestPlugin::new());
        let p2 = Arc::new(TestPlugin::new());
        let registry = PluginRegistry::new(vec![p1.clone(), p2.clone()]);

        let settings = HashMap::new();
        registry
            .on_session_start(&"10.0.0.1".to_string(), &settings)
            .await;
        assert_eq!(p1.start_count.load(Ordering::SeqCst), 1);
        assert_eq!(p2.start_count.load(Ordering::SeqCst), 1);

        let exchange = make_exchange();
        registry
            .on_exchange(&"10.0.0.1".to_string(), &exchange, 1)
            .await;
        assert_eq!(p1.exchange_count.load(Ordering::SeqCst), 1);
        assert_eq!(p2.exchange_count.load(Ordering::SeqCst), 1);

        registry.on_session_stop(&"10.0.0.1".to_string()).await;
        assert_eq!(p1.stop_count.load(Ordering::SeqCst), 1);
        assert_eq!(p2.stop_count.load(Ordering::SeqCst), 1);

        registry.on_session_clear(&"10.0.0.1".to_string()).await;
        assert_eq!(p1.clear_count.load(Ordering::SeqCst), 1);
        assert_eq!(p2.clear_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn registry_passes_plugin_specific_settings() {
        use std::sync::Mutex;

        struct SettingsCapture {
            captured: Mutex<Option<Value>>,
        }

        #[async_trait]
        impl ProxyPlugin for SettingsCapture {
            fn name(&self) -> &str {
                "capture"
            }
            async fn on_session_start(&self, _session_id: &SessionId, settings: &Value) {
                *self.captured.lock().unwrap() = Some(settings.clone());
            }
            async fn on_exchange(&self, _: &SessionId, _: &HttpExchange, _iteration: u32) {}
            async fn on_session_stop(&self, _: &SessionId) {}
            async fn on_session_clear(&self, _: &SessionId) {}
        }

        let plugin = Arc::new(SettingsCapture {
            captured: Mutex::new(None),
        });
        let registry = PluginRegistry::new(vec![plugin.clone()]);

        let mut settings = HashMap::new();
        settings.insert(
            "capture".to_string(),
            serde_json::json!({"redactCredentials": false}),
        );
        registry
            .on_session_start(&"10.0.0.1".to_string(), &settings)
            .await;

        let captured = plugin.captured.lock().unwrap().clone().unwrap();
        assert_eq!(captured["redactCredentials"], false);
    }

    #[tokio::test]
    async fn registry_sends_empty_object_for_unconfigured_plugin() {
        use std::sync::Mutex;

        struct SettingsCapture {
            captured: Mutex<Option<Value>>,
        }

        #[async_trait]
        impl ProxyPlugin for SettingsCapture {
            fn name(&self) -> &str {
                "nocfg"
            }
            async fn on_session_start(&self, _session_id: &SessionId, settings: &Value) {
                *self.captured.lock().unwrap() = Some(settings.clone());
            }
            async fn on_exchange(&self, _: &SessionId, _: &HttpExchange, _iteration: u32) {}
            async fn on_session_stop(&self, _: &SessionId) {}
            async fn on_session_clear(&self, _: &SessionId) {}
        }

        let plugin = Arc::new(SettingsCapture {
            captured: Mutex::new(None),
        });
        let registry = PluginRegistry::new(vec![plugin.clone()]);

        // No settings for "nocfg" plugin
        let settings = HashMap::new();
        registry
            .on_session_start(&"10.0.0.1".to_string(), &settings)
            .await;

        let captured = plugin.captured.lock().unwrap().clone().unwrap();
        assert!(captured.is_object());
        // Unconfigured plugins get an empty JSON object.
        assert_eq!(captured.as_object().unwrap().len(), 0);
    }
}
