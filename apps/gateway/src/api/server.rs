// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tracing::info;

use super::routes::{self, ApiState};

/// Build and run the Axum API server on the given port.
pub async fn run_api_server(
    state: Arc<ApiState>,
    port: u16,
    plugin_routes: Vec<(&str, Router)>,
) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/proxy", get(routes::get_proxy_status))
        .route(
            "/proxy/rootCertificate",
            get(routes::get_root_certificate),
        )
        .route("/session/start", post(routes::post_session_start))
        .route("/session/stop", post(routes::post_session_stop))
        .with_state(state);

    // Mount plugin routes (e.g., GET /proxy/har from HAR plugin)
    // These already have their own state, so merge after with_state
    let app = plugin_routes
        .into_iter()
        .fold(app, |app, (prefix, router)| {
            if prefix.is_empty() {
                app.merge(router)
            } else {
                app.nest(prefix, router)
            }
        });

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
