// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! REST API route handlers for session CRUD, health checks, and CA certificate retrieval.
//!
//! All session mutations go through `SessionManager`, which handles plugin
//! lifecycle notifications. The client IP is extracted from the TCP connection
//! (via Axum's `ConnectInfo`) and used as the session binding key.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, State};
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

/// GET /health — liveness / readiness check
pub async fn get_health() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

/// Response payload for health check.
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

/// POST /api/v1/sessions — create a new session
pub async fn post_create_session(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<ApiState>>,
    Json(body): Json<SessionCreateRequest>,
) -> impl IntoResponse {
    let client_ip = addr.ip();
    let plugin_settings = body.plugins.unwrap_or_default();

    info!("Creating session for {}", client_ip);

    match state
        .session_manager
        .create_session(client_ip, plugin_settings)
        .await
    {
        Ok(session_id) => (
            StatusCode::CREATED,
            Json(SessionCreatedResponse { id: session_id }),
        )
            .into_response(),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
    }
}

/// Request body for session creation.
#[derive(Deserialize)]
pub struct SessionCreateRequest {
    pub plugins: Option<HashMap<String, serde_json::Value>>,
}

/// Response body after session creation.
#[derive(Serialize)]
pub struct SessionCreatedResponse {
    pub id: String,
}

/// GET /api/v1/sessions — list all sessions
pub async fn get_list_sessions(State(state): State<Arc<ApiState>>) -> impl IntoResponse {
    let sessions = state.session_manager.list_sessions();
    Json(sessions)
}

/// GET /api/v1/sessions/:id — session status
pub async fn get_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    match state.session_manager.get_session(&session_id) {
        Some(info) => Json(info).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// POST /api/v1/sessions/:id/stop — stop a session
pub async fn post_stop_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    info!("Stopping session {}", session_id);

    match state.session_manager.stop_session(&session_id).await {
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

/// DELETE /api/v1/sessions/:id — delete a session and clean up
pub async fn delete_session(
    Path(session_id): Path<String>,
    State(state): State<Arc<ApiState>>,
) -> impl IntoResponse {
    info!("Deleting session {}", session_id);

    match state.session_manager.delete_session(&session_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(crate::session::SessionError::NotFound) => {
            (StatusCode::NOT_FOUND, "No session found").into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// GET /api/v1/cacert — CA certificate in PEM format
pub async fn get_cacert(State(state): State<Arc<ApiState>>) -> impl IntoResponse {
    let pem = state.ca.ca_cert_pem();

    (
        [(axum::http::header::CONTENT_TYPE, "application/x-pem-file")],
        pem,
    )
}
