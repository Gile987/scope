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
use base64::Engine;
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
use tower::ServiceExt;
use tracing::{debug, info, warn};

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
                async move {
                    // Prefer session ID from Proxy-Authorization header (set when
                    // workers embed the session ID in the proxy URL userinfo).
                    // Fall back to IP-based lookup for backward compatibility.
                    let session_id = extract_session_from_proxy_auth(&req)
                        .and_then(|id| {
                            if state.session_manager.is_active(&id) {
                                Some(id)
                            } else {
                                debug!("Proxy-Authorization session {} is not active, falling back to IP lookup", id);
                                None
                            }
                        })
                        .or_else(|| {
                            // Fast path: session already in memory.
                            state.session_manager.session_id_for_ip(&client_ip)
                        });

                    // Slow path: pod may have restarted — try Redis restore.
                    let session_id = match session_id {
                        Some(id) => Some(id),
                        None => {
                            state
                                .session_manager
                                .restore_session_for_ip(&client_ip)
                                .await
                        }
                    };
                    handle_request(req, session_id, state, peer_addr).await
                }
            }),
        )
        .with_upgrades()
        .await?;

    Ok(())
}

/// Returns true if this request should be routed to the API (Axum) rather
/// than the proxy pipeline. API requests use relative URIs (no host in the
/// request-target), while proxy requests use CONNECT or absolute URIs.
fn is_api_request<B>(req: &hyper::Request<B>) -> bool {
    if req.method() == Method::CONNECT {
        return false;
    }
    // Proxy clients send absolute-form URIs (e.g. http://example.com/path).
    // Regular HTTP clients send origin-form (e.g. /api/v1/sessions).
    req.uri().host().is_none()
}

/// Extract a session ID from the `Proxy-Authorization: Basic <base64>` header.
///
/// Workers embed the session ID in the proxy URL userinfo field
/// (`http://<sessionId>@host:port`), which HTTP clients send as
/// `Proxy-Authorization: Basic base64(sessionId:)`. We decode the header
/// and return the username portion (the session ID).
fn extract_session_from_proxy_auth<B>(req: &hyper::Request<B>) -> Option<String> {
    let header = req.headers().get(http::header::PROXY_AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded_str = String::from_utf8(decoded).ok()?;
    // Format is "username:password" — session ID is the username part.
    let session_id = decoded_str.split(':').next()?.to_string();
    if session_id.is_empty() {
        None
    } else {
        Some(session_id)
    }
}

async fn handle_request(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
    peer_addr: SocketAddr,
) -> Result<hyper::Response<StreamingBody>, hyper::Error> {
    // Route API requests (relative URIs) to the Axum router.
    if is_api_request(&req) {
        let path = req.uri().path();
        if path.starts_with("/api/") {
            debug!(target: "gateway::api", "{} {} from {} session={:?}", req.method(), req.uri(), peer_addr.ip(), session_id);
        } else {
            debug!(target: "gateway::internal", "{} {} from {}", req.method(), req.uri(), peer_addr.ip());
        }
        return Ok(dispatch_to_api(req, state, peer_addr).await);
    }

    debug!(target: "gateway::proxy", "{} {} from {} session={:?}", req.method(), req.uri(), peer_addr.ip(), session_id);

    if req.method() == Method::CONNECT {
        match handle_connect(req, session_id, state, peer_addr).await {
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
    // oneshot() consumes the router clone and drives it to completion.
    let router = state.api_router.clone();

    match router.oneshot(req).await {
        Ok(resp) => {
            // Convert Axum's response body to our StreamingBody type.
            let (parts, body) = resp.into_parts();
            let body_bytes = match body.collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => Bytes::new(),
            };
            hyper::Response::from_parts(parts, StreamingBody::Buffered(Full::new(body_bytes)))
        }
        Err(infallible) => match infallible {},
    }
}

async fn handle_connect(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
    peer_addr: SocketAddr,
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    let host = req
        .uri()
        .authority()
        .map(|a| a.to_string())
        .unwrap_or_default();

    info!(
        "CONNECT {} from ip={} session={:?}",
        host,
        peer_addr.ip(),
        session_id
    );

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

    debug!(target: "gateway::proxy", "HTTP forward {} {} session={:?}", method, uri, session_id);

    let should_record = session_id.is_some() && state.url_filter.matches_host(&host);
    let sid_for_record = session_id.unwrap_or_default();

    // Capture request metadata before consuming
    let req_method = method.clone();
    let req_uri: http::Uri = uri.to_string().parse()?;
    let mut req_headers = req.headers().clone();

    // Give plugins a chance to mutate headers (e.g. refresh auth tokens)
    if should_record {
        state
            .registry
            .on_request(&sid_for_record, &req_uri, &mut req_headers)
            .await?;
    }

    // Read request body (requests are typically small)
    let (parts, body) = req.into_parts();
    let req_body_bytes = body.collect().await?.to_bytes();

    // Rebuild the request for upstream
    let mut upstream_req = hyper::Request::builder()
        .method(parts.method)
        .uri(&uri)
        .version(parts.version);
    for (name, value) in &req_headers {
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

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::Request;

    /// Helper to build a minimal request with a given method and URI.
    fn make_request(method: &str, uri: &str) -> Request<()> {
        Request::builder().method(method).uri(uri).body(()).unwrap()
    }

    #[test]
    fn is_api_request_connect_returns_false() {
        let req = make_request("CONNECT", "example.com:443");
        assert!(!is_api_request(&req));
    }

    #[test]
    fn is_api_request_absolute_uri_returns_false() {
        let req = make_request("GET", "http://example.com/path");
        assert!(!is_api_request(&req));
    }

    #[test]
    fn is_api_request_relative_uri_returns_true() {
        let req = make_request("GET", "/api/v1/sessions");
        assert!(is_api_request(&req));
    }

    #[test]
    fn is_api_request_root_returns_true() {
        let req = make_request("GET", "/");
        assert!(is_api_request(&req));
    }

    #[test]
    fn is_api_request_health_returns_true() {
        let req = make_request("GET", "/health");
        assert!(is_api_request(&req));
    }

    #[test]
    fn is_api_request_post_relative_returns_true() {
        let req = make_request("POST", "/api/v1/sessions");
        assert!(is_api_request(&req));
    }

    /// Helper to build a request with a Proxy-Authorization header.
    fn make_proxy_auth_request(session_id: &str) -> Request<()> {
        use base64::Engine;
        let credentials = format!("{}:", session_id);
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials);
        Request::builder()
            .method("CONNECT")
            .uri("example.com:443")
            .header(http::header::PROXY_AUTHORIZATION, format!("Basic {}", encoded))
            .body(())
            .unwrap()
    }

    #[test]
    fn extract_session_from_valid_proxy_auth() {
        let req = make_proxy_auth_request("550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(
            extract_session_from_proxy_auth(&req),
            Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
        );
    }

    #[test]
    fn extract_session_returns_none_without_header() {
        let req = make_request("CONNECT", "example.com:443");
        assert_eq!(extract_session_from_proxy_auth(&req), None);
    }

    #[test]
    fn extract_session_returns_none_for_empty_username() {
        // Basic base64(":password") — empty username
        let encoded = base64::engine::general_purpose::STANDARD.encode(":password");
        let req = Request::builder()
            .method("CONNECT")
            .uri("example.com:443")
            .header(http::header::PROXY_AUTHORIZATION, format!("Basic {}", encoded))
            .body(())
            .unwrap();
        assert_eq!(extract_session_from_proxy_auth(&req), None);
    }

    #[test]
    fn extract_session_returns_none_for_non_basic_auth() {
        let req = Request::builder()
            .method("CONNECT")
            .uri("example.com:443")
            .header(http::header::PROXY_AUTHORIZATION, "Bearer some-token")
            .body(())
            .unwrap();
        assert_eq!(extract_session_from_proxy_auth(&req), None);
    }

    #[test]
    fn extract_session_returns_none_for_invalid_base64() {
        let req = Request::builder()
            .method("CONNECT")
            .uri("example.com:443")
            .header(http::header::PROXY_AUTHORIZATION, "Basic !!!invalid!!!")
            .body(())
            .unwrap();
        assert_eq!(extract_session_from_proxy_auth(&req), None);
    }
}
