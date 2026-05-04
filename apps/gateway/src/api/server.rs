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
