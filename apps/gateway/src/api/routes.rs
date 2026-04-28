// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::ca::CertificateAuthority;
use crate::session::SessionManager;

/// Shared state for API routes.
pub struct ApiState {
    pub session_manager: Arc<SessionManager>,
    pub ca: Arc<CertificateAuthority>,
}

/// GET /proxy — session status
pub async fn get_proxy_status(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    let session_id = addr.ip().to_string();
    let active = state.session_manager.get_status(&session_id).unwrap_or(false);

    Json(ProxyStatus { active })
}

#[derive(Serialize)]
pub struct ProxyStatus {
    pub active: bool,
}

/// POST /session/start — start a session with per-plugin settings
pub async fn post_session_start(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ApiState>>,
    Json(body): Json<SessionStartRequest>,
) -> impl IntoResponse {
    let session_id = addr.ip().to_string();
    let plugin_settings = body.plugins.unwrap_or_default();

    info!("Starting session for {}", session_id);

    match state
        .session_manager
        .start_session(session_id, plugin_settings)
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SessionStartRequest {
    pub plugins: Option<HashMap<String, serde_json::Value>>,
}

/// POST /session/stop — stop a session
pub async fn post_session_stop(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    let session_id = addr.ip().to_string();

    info!("Stopping session for {}", session_id);

    match state.session_manager.stop_session(&session_id) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(crate::session::SessionError::NotFound) => {
            (StatusCode::NOT_FOUND, "No session found").into_response()
        }
        Err(crate::session::SessionError::NotActive) => {
            (StatusCode::CONFLICT, "Session already stopped").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// GET /proxy/rootCertificate — CA certificate in PEM format
pub async fn get_root_certificate(
    State(state): State<Arc<ApiState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let _format = params.get("format").map(|s| s.as_str()).unwrap_or("crt");
    let pem = state.ca.ca_cert_pem();

    (
        [(
            axum::http::header::CONTENT_TYPE,
            "application/x-pem-file",
        )],
        pem,
    )
}


