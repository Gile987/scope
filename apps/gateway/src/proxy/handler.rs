// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HTTP proxy handler implementing CONNECT tunneling and plain HTTP forwarding.
//!
//! CONNECT requests are upgraded to raw TCP, then either TLS-intercepted (when
//! the URL matches a watch pattern and a session is active) or passed through
//! as an opaque tunnel. Plain HTTP requests are forwarded via a shared
//! connection-pooling client and streamed back to the caller.
//!
//! The same port also serves the REST API (Axum router): requests with relative
//! URIs (e.g. GET /api/v1/sessions) are dispatched to Axum, while CONNECT and
//! absolute-URI requests go through the proxy path.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::connect_info::ConnectInfo;
use bytes::Bytes;
use http::{Method, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tower::Service;
use tracing::{debug, warn};

use crate::ca::CertificateAuthority;
use crate::filters::UrlFilter;
use crate::plugin::{PluginRegistry, SessionId};
use crate::proxy::body::{
    spawn_stream_and_record, streaming_response, ExchangeContext, StreamingBody,
};
use crate::session::SessionManager;

/// Shared state for the proxy handler.
pub struct ProxyState {
    pub session_manager: Arc<SessionManager>,
    pub registry: Arc<PluginRegistry>,
    pub ca: Arc<CertificateAuthority>,
    pub url_filter: Arc<UrlFilter>,
    /// Shared HTTP/1.1 client for plain (non-CONNECT) forwarding.
    /// Using a single client avoids creating a new connection pool per request.
    pub http_client: Client<HttpConnector, Full<Bytes>>,
    /// Pre-built TLS config for upstream connections (MITM relay).
    /// Contains Mozilla roots + any additional CA certs from config.
    pub upstream_tls_config: Arc<rustls::ClientConfig>,
    /// Axum router for the REST API, served on the same port.
    pub api_router: axum::Router,
}

/// Handle a single client connection on the unified port.
///
/// Requests are dispatched as follows:
/// - `CONNECT host:port` → proxy tunnel (TLS interception or passthrough)
/// - Absolute URI (e.g. `GET http://example.com/path`) → plain HTTP forwarding
/// - Relative URI (e.g. `GET /api/v1/sessions`) → Axum REST API
pub async fn handle_client(
    stream: TcpStream,
    peer_addr: std::net::SocketAddr,
    state: Arc<ProxyState>,
) -> anyhow::Result<()> {
    let client_ip = peer_addr.ip();

    let io = TokioIo::new(stream);
    let state_clone = state.clone();

    // Run an HTTP/1.1 server on the client connection. preserve_header_case and
    // title_case_headers ensure we don't mangle headers — important for proxies.
    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let state = state_clone.clone();
                let session_id = state.session_manager.session_id_for_ip(&client_ip);
                async move { handle_request(req, session_id, state, peer_addr).await }
            }),
        )
        .with_upgrades()
        .await?;

    Ok(())
}

/// Returns true if this request should be routed to the API (Axum) rather
/// than the proxy pipeline. API requests use relative URIs (no host in the
/// request-target), while proxy requests use CONNECT or absolute URIs.
fn is_api_request(req: &hyper::Request<Incoming>) -> bool {
    if req.method() == Method::CONNECT {
        return false;
    }
    // Proxy clients send absolute-form URIs (e.g. http://example.com/path).
    // Regular HTTP clients send origin-form (e.g. /api/v1/sessions).
    req.uri().host().is_none()
}

async fn handle_request(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
    peer_addr: SocketAddr,
) -> Result<hyper::Response<StreamingBody>, hyper::Error> {
    // Route API requests (relative URIs) to the Axum router.
    if is_api_request(&req) {
        return Ok(dispatch_to_api(req, state, peer_addr).await);
    }

    if req.method() == Method::CONNECT {
        match handle_connect(req, session_id, state).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("CONNECT error: {}", e);
                Ok(hyper::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(StreamingBody::Buffered(Full::new(Bytes::from(format!(
                        "CONNECT failed: {}",
                        e
                    )))))
                    .unwrap())
            }
        }
    } else {
        match handle_plain_http(req, session_id, state).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("HTTP forward error: {}", e);
                Ok(hyper::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(StreamingBody::Buffered(Full::new(Bytes::from(format!(
                        "Forward failed: {}",
                        e
                    )))))
                    .unwrap())
            }
        }
    }
}

/// Dispatch a request to the Axum API router, injecting ConnectInfo so that
/// route handlers can extract the client's SocketAddr.
async fn dispatch_to_api(
    req: hyper::Request<Incoming>,
    state: Arc<ProxyState>,
    peer_addr: SocketAddr,
) -> hyper::Response<StreamingBody> {
    // Inject ConnectInfo extension so Axum handlers can extract the client IP.
    let (mut parts, body) = req.into_parts();
    parts.extensions.insert(ConnectInfo(peer_addr));
    let req = hyper::Request::from_parts(parts, body);

    // Clone the router — Axum routers are cheap to clone (Arc internals).
    let mut router = state.api_router.clone();

    match router.call(req).await {
        Ok(resp) => {
            // Convert Axum's response body to our StreamingBody type.
            let (parts, body) = resp.into_parts();
            let body_bytes = match body.collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => Bytes::new(),
            };
            hyper::Response::from_parts(
                parts,
                StreamingBody::Buffered(Full::new(body_bytes)),
            )
        }
        Err(infallible) => match infallible {},
    }
}

async fn handle_connect(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    let host = req
        .uri()
        .authority()
        .map(|a| a.to_string())
        .unwrap_or_default();

    debug!("CONNECT {} from session {:?}", host, session_id);

    // Decide: intercept or passthrough
    let should_intercept = session_id.is_some() && state.url_filter.matches_host(&host);
    let sid_for_intercept = session_id.unwrap_or_default();

    // We need to upgrade the connection
    let resp = hyper::Response::builder()
        .status(StatusCode::OK)
        .body(StreamingBody::Buffered(Full::new(Bytes::new())))?;

    // The tunnel runs in a background task: we return the 200 response immediately
    // to complete the HTTP upgrade handshake, then the spawned task takes over the
    // upgraded connection for either TLS interception or raw TCP passthrough.
    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let io = TokioIo::new(upgraded);
                if should_intercept {
                    if let Err(e) =
                        super::tls::intercept_tls(io, &host, &sid_for_intercept, &state).await
                    {
                        // Connection resets are expected when sessions are stopped mid-flight
                        let msg = e.to_string();
                        if msg.contains("connection")
                            || msg.contains("reset")
                            || msg.contains("broken pipe")
                        {
                            debug!("TLS interception ended for {}: {}", host, e);
                        } else {
                            warn!("TLS interception error for {}: {}", host, e);
                        }
                    }
                } else if let Err(e) = tunnel_passthrough(io, &host).await {
                    debug!("Tunnel passthrough ended for {}: {}", host, e);
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

/// Plain HTTP forwarding with streaming response (non-CONNECT requests).
async fn handle_plain_http(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    // Ensure we have an absolute URI (required for proxy forwarding).
    // If the client sent a relative URI (e.g. GET /path), reconstruct from the Host header.
    let uri = if req.uri().host().is_none() {
        let host = req
            .headers()
            .get(hyper::header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown");
        let scheme = req.uri().scheme_str().unwrap_or("http");
        let path_and_query = req
            .uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/");
        format!("{}://{}{}", scheme, host, path_and_query).parse::<http::Uri>()?
    } else {
        req.uri().clone()
    };
    let method = req.method().clone();
    let host = uri.host().unwrap_or("unknown").to_string();

    debug!("HTTP {} {} from session {:?}", method, uri, session_id);

    let should_record = session_id.is_some() && state.url_filter.matches_host(&host);
    let sid_for_record = session_id.unwrap_or_default();

    // Capture request metadata before consuming
    let req_method = method.clone();
    let req_uri: http::Uri = uri.to_string().parse()?;
    let req_headers = req.headers().clone();

    // Read request body (requests are typically small)
    let (parts, body) = req.into_parts();
    let req_body_bytes = body.collect().await?.to_bytes();

    // Rebuild the request for upstream
    let mut upstream_req = hyper::Request::builder()
        .method(parts.method)
        .uri(&uri)
        .version(parts.version);
    for (name, value) in &parts.headers {
        upstream_req = upstream_req.header(name, value);
    }
    let upstream_req = upstream_req.body(Full::new(req_body_bytes.clone()))?;

    // Forward to upstream using the shared HTTP client
    let started_at = chrono::Utc::now();
    let request_instant = std::time::Instant::now();
    let upstream_resp = state.http_client.request(upstream_req).await?;

    // TTFB: time from request start to response headers received
    let wait_ms = request_instant.elapsed().as_millis() as u64;

    let resp_status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    let (tx, rx) = mpsc::channel::<Frame<Bytes>>(32);
    let upstream_body = upstream_resp.into_body();

    if should_record {
        let sid_clone = sid_for_record.clone();
        let ctx = ExchangeContext {
            req_method,
            req_uri,
            req_headers,
            req_body: req_body_bytes,
            resp_status,
            resp_headers: resp_headers.clone(),
            started_at,
            wait_ms,
            request_instant,
            session_id: sid_for_record,
        };
        let state_clone = state.clone();
        spawn_stream_and_record(upstream_body, tx, ctx, state, uri.to_string(), move || {
            state_clone.session_manager.touch(&sid_clone);
        });
    } else {
        // No recording — just forward frames to the client
        let uri_for_log = uri.to_string();
        tokio::spawn(async move {
            let mut upstream_body = upstream_body;
            while let Some(frame_result) = upstream_body.frame().await {
                match frame_result {
                    Ok(frame) => {
                        if tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!("Upstream body error for {}: {}", uri_for_log, e);
                        break;
                    }
                }
            }
        });
    }

    streaming_response(resp_status, &resp_headers, rx)
}
