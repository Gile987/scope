// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Axum REST API router for session management and plugin endpoints.
//!
//! Routes are nested under `/api/v1/` with session-scoped sub-routes at
//! `/api/v1/sessions/{id}/`. Plugin routers are merged into the session
//! scope so plugins can expose per-session endpoints (e.g., GET /har).
//!
//! The router is embedded into the proxy's unified port rather than running
//! on a separate listener. See `proxy::handler` for how API requests are
//! distinguished from proxy traffic.

use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;

use super::routes::{self, ApiState};

/// Build the Axum router (without binding to a port).
///
/// The returned router is used by the unified proxy listener to handle
/// non-proxy requests (relative-URI paths like `/api/v1/...` and `/health`).
pub fn build_api_router(state: Arc<ApiState>, plugin_session_routes: Vec<Router>) -> Router {
    // Session sub-routes: /api/v1/sessions/:id/*
    // Start with the core session routes that need ApiState
    let session_routes = Router::new()
        .route("/", get(routes::get_session))
        .route("/stop", post(routes::post_stop_session))
        .route("/rotate", post(routes::post_rotate))
        .route("/", delete(routes::delete_session))
        .with_state(state.clone());

    // Plugin routers come with their own State already applied,
    // so we can merge them directly without re-wrapping in ApiState.
    let session_routes = plugin_session_routes
        .into_iter()
        .fold(session_routes, |r, plugin_r| r.merge(plugin_r));

    let api_v1 = Router::new()
        .route("/cacert", get(routes::get_cacert))
        .route("/sessions", post(routes::post_create_session))
        .route("/sessions", get(routes::get_list_sessions))
        .with_state(state.clone())
        .nest("/sessions/{id}", session_routes);

    Router::new()
        .route("/health", get(routes::get_health))
        .route("/health/alive", get(routes::get_health_alive))
        .route("/health/ready", get(routes::get_health_ready))
        .with_state(state)
        .nest("/api/v1", api_v1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::api::routes::ApiState;
    use crate::ca::CertificateAuthority;
    use crate::iteration_store::{IterationStore, LocalIterationStore};
    use crate::plugin::PluginRegistry;
    use crate::session::SessionManager;

    fn test_state() -> Arc<ApiState> {
        let tmp = tempfile::TempDir::new().unwrap();
        let ca = Arc::new(CertificateAuthority::new(tmp.path(), 10).unwrap());
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let iteration_store = Arc::new(LocalIterationStore::new()) as Arc<dyn IterationStore>;
        let mgr = Arc::new(SessionManager::new(
            registry,
            std::time::Duration::from_secs(300),
            100,
            iteration_store,
        ));
        // Leak the TempDir so the CA directory lives for the test duration.
        std::mem::forget(tmp);
        Arc::new(ApiState {
            session_manager: mgr,
            ca,
            blob_container_client: None,
        })
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn build_api_router_serves_health() {
        let app = build_api_router(test_state(), vec![]);
        for path in ["/health", "/health/alive", "/health/ready"] {
            let resp = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(resp.status(), 200, "path {} should be 200", path);
        }
    }

    #[tokio::test]
    async fn build_api_router_serves_cacert() {
        let app = build_api_router(test_state(), vec![]);
        let resp = app
            .oneshot(Request::get("/api/v1/cacert").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let ct = resp
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(ct.contains("pem"), "content-type was {}", ct);
        let body = body_string(resp).await;
        assert!(body.contains("BEGIN CERTIFICATE"));
    }

    #[tokio::test]
    async fn build_api_router_session_lifecycle() {
        let app = build_api_router(test_state(), vec![]);
        let id = uuid::Uuid::new_v4().to_string();

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);

        // List shows it
        let resp = app
            .clone()
            .oneshot(
                Request::get("/api/v1/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body = body_string(resp).await;
        assert!(body.contains(&id));

        // Get session
        let resp = app
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/sessions/{}", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Rotate (sessions start at iter 1; expected=1 → ok, advances to 2)
        let resp = app
            .clone()
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/rotate?expected=1", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Rotate with stale expected → 409
        let resp = app
            .clone()
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/rotate?expected=1", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 409);

        // Stop
        let resp = app
            .clone()
            .oneshot(
                Request::post(format!("/api/v1/sessions/{}/stop", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);

        // Delete
        let resp = app
            .clone()
            .oneshot(
                Request::delete(format!("/api/v1/sessions/{}", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }

    #[tokio::test]
    async fn build_api_router_merges_plugin_routes() {
        use axum::routing::get;

        async fn plugin_handler() -> &'static str {
            "plugin-ok"
        }
        let plugin_router: Router = Router::new().route("/plugin/probe", get(plugin_handler));

        let app = build_api_router(test_state(), vec![plugin_router]);
        let id = uuid::Uuid::new_v4().to_string();

        // Create the session so the plugin sub-route is reachable.
        let resp = app
            .clone()
            .oneshot(
                Request::post("/api/v1/sessions")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(r#"{{"id":"{}"}}"#, id)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);

        let resp = app
            .oneshot(
                Request::get(format!("/api/v1/sessions/{}/plugin/probe", id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(body_string(resp).await, "plugin-ok");
    }
}
