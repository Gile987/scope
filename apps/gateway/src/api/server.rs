// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use tracing::info;

use super::routes::{self, ApiState};

/// Build and run the Axum API server on the given port.
pub async fn run_api_server(
    state: Arc<ApiState>,
    port: u16,
    plugin_session_routes: Vec<Router>,
) -> anyhow::Result<()> {
    // Session sub-routes: /api/v1/sessions/:id/*
    // Start with the core session routes that need ApiState
    let session_routes = Router::new()
        .route("/", get(routes::get_session))
        .route("/stop", post(routes::post_stop_session))
        .route("/", delete(routes::delete_session))
        .with_state(state.clone());

    // Merge plugin session-scoped routes (already have their own state applied)
    let session_routes = plugin_session_routes
        .into_iter()
        .fold(session_routes, |r, plugin_r| r.merge(plugin_r));

    let api_v1 = Router::new()
        .route("/cacert", get(routes::get_cacert))
        .route("/sessions", post(routes::post_create_session))
        .route("/sessions", get(routes::get_list_sessions))
        .with_state(state)
        .nest("/sessions/{id}", session_routes);

    let app = Router::new()
        .route("/healthz", get(routes::get_health))
        .nest("/api/v1", api_v1);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("API server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
