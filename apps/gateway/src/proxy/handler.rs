// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::sync::Arc;

use bytes::Bytes;
use http::{Method, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tracing::{debug, warn};

use crate::ca::CertificateAuthority;
use crate::filters::UrlFilter;
use crate::plugin::{PluginRegistry, SessionId};
use crate::session::SessionManager;

/// Shared state for the proxy handler.
pub struct ProxyState {
    pub session_manager: Arc<SessionManager>,
    pub registry: Arc<PluginRegistry>,
    pub ca: Arc<CertificateAuthority>,
    pub url_filter: Arc<UrlFilter>,
}

/// Handle a single client connection on the proxy port.
pub async fn handle_client(
    stream: TcpStream,
    peer_addr: std::net::SocketAddr,
    state: Arc<ProxyState>,
) -> anyhow::Result<()> {
    let session_id = peer_addr.ip().to_string();

    let io = TokioIo::new(stream);
    let state_clone = state.clone();
    let session_id_clone = session_id.clone();

    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let state = state_clone.clone();
                let sid = session_id_clone.clone();
                async move { handle_request(req, sid, state).await }
            }),
        )
        .with_upgrades()
        .await?;

    Ok(())
}

async fn handle_request(
    req: hyper::Request<Incoming>,
    session_id: SessionId,
    state: Arc<ProxyState>,
) -> Result<hyper::Response<Full<Bytes>>, hyper::Error> {
    if req.method() == Method::CONNECT {
        match handle_connect(req, session_id, state).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("CONNECT error: {}", e);
                Ok(hyper::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from(format!("CONNECT failed: {}", e))))
                    .unwrap())
            }
        }
    } else {
        // Plain HTTP forwarding (non-CONNECT)
        match handle_plain_http(req, session_id, state).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("HTTP forward error: {}", e);
                Ok(hyper::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from(format!("Forward failed: {}", e))))
                    .unwrap())
            }
        }
    }
}

async fn handle_connect(
    req: hyper::Request<Incoming>,
    session_id: SessionId,
    state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<Full<Bytes>>> {
    let host = req
        .uri()
        .authority()
        .map(|a| a.to_string())
        .unwrap_or_default();

    debug!("CONNECT {} from {}", host, session_id);

    // Decide: intercept or passthrough
    let should_intercept =
        state.session_manager.is_active(&session_id) && state.url_filter.matches_host(&host);

    // We need to upgrade the connection
    let resp = hyper::Response::builder()
        .status(StatusCode::OK)
        .body(Full::new(Bytes::new()))?;

    // Spawn the tunnel after sending 200
    tokio::spawn(async move {
        // Wait for the upgrade
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let io = TokioIo::new(upgraded);
                if should_intercept {
                    if let Err(e) =
                        super::tls::intercept_tls(io, &host, &session_id, &state).await
                    {
                        warn!("TLS interception error for {}: {}", host, e);
                    }
                } else {
                    if let Err(e) = tunnel_passthrough(io, &host).await {
                        debug!("Tunnel passthrough ended for {}: {}", host, e);
                    }
                }
            }
            Err(e) => {
                warn!("Upgrade failed for {}: {}", host, e);
            }
        }
    });

    Ok(resp)
}

/// Plain TCP tunnel — no TLS interception, no recording.
async fn tunnel_passthrough<S>(client_io: S, host: &str) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let upstream = TcpStream::connect(host).await?;
    let (mut client_read, mut client_write) = tokio::io::split(client_io);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);

    let c2u = tokio::io::copy(&mut client_read, &mut upstream_write);
    let u2c = tokio::io::copy(&mut upstream_read, &mut client_write);

    tokio::select! {
        r = c2u => { r?; }
        r = u2c => { r?; }
    }

    Ok(())
}

/// Plain HTTP forwarding (non-CONNECT requests).
async fn handle_plain_http(
    req: hyper::Request<Incoming>,
    _session_id: SessionId,
    _state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<Full<Bytes>>> {
    // For now, return 501 for non-CONNECT (agents use HTTPS via CONNECT)
    Ok(hyper::Response::builder()
        .status(StatusCode::NOT_IMPLEMENTED)
        .body(Full::new(Bytes::from(
            "Plain HTTP forwarding not implemented — use HTTPS via CONNECT",
        )))?)
}
