// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use bytes::Bytes;
use http::{Method, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::ca::CertificateAuthority;
use crate::filters::UrlFilter;
use crate::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, PluginRegistry, SessionId};
use crate::session::SessionManager;

/// A streaming response body backed by an mpsc channel.
struct ChannelBody {
    rx: mpsc::Receiver<Frame<Bytes>>,
}

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.get_mut().rx.poll_recv(cx).map(|opt| opt.map(Ok))
    }
}

/// Response body — either buffered (CONNECT, errors) or streaming (HTTP forward).
enum ProxyBody {
    Buffered(Full<Bytes>),
    Streaming(ChannelBody),
}

impl hyper::body::Body for ProxyBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.get_mut() {
            ProxyBody::Buffered(inner) => Pin::new(inner).poll_frame(cx),
            ProxyBody::Streaming(inner) => Pin::new(inner).poll_frame(cx),
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            ProxyBody::Buffered(inner) => inner.is_end_stream(),
            ProxyBody::Streaming(_) => false,
        }
    }
}

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
    let client_ip = peer_addr.ip();

    let io = TokioIo::new(stream);
    let state_clone = state.clone();

    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let state = state_clone.clone();
                // Resolve IP → session ID on each request (session may start/stop between requests)
                let session_id = state.session_manager.session_id_for_ip(&client_ip);
                async move { handle_request(req, session_id, state).await }
            }),
        )
        .with_upgrades()
        .await?;

    Ok(())
}

async fn handle_request(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
) -> Result<hyper::Response<ProxyBody>, hyper::Error> {
    if req.method() == Method::CONNECT {
        match handle_connect(req, session_id, state).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("CONNECT error: {}", e);
                Ok(hyper::Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(ProxyBody::Buffered(Full::new(Bytes::from(format!("CONNECT failed: {}", e)))))
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
                    .body(ProxyBody::Buffered(Full::new(Bytes::from(format!("Forward failed: {}", e)))))
                    .unwrap())
            }
        }
    }
}

async fn handle_connect(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<ProxyBody>> {
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
        .body(ProxyBody::Buffered(Full::new(Bytes::new())))?;

    // Spawn the tunnel after sending 200
    tokio::spawn(async move {
        // Wait for the upgrade
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let io = TokioIo::new(upgraded);
                if should_intercept {
                    if let Err(e) =
                        super::tls::intercept_tls(io, &host, &sid_for_intercept, &state).await
                    {
                        // Connection resets are expected when sessions are stopped mid-flight
                        let msg = e.to_string();
                        if msg.contains("connection") || msg.contains("reset") || msg.contains("broken pipe") {
                            debug!("TLS interception ended for {}: {}", host, e);
                        } else {
                            warn!("TLS interception error for {}: {}", host, e);
                        }
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

/// Plain HTTP forwarding with streaming response (non-CONNECT requests).
async fn handle_plain_http(
    req: hyper::Request<Incoming>,
    session_id: Option<SessionId>,
    state: Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<ProxyBody>> {
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

    // Forward to upstream
    let started_at = chrono::Utc::now();
    let start_instant = std::time::Instant::now();
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let upstream_resp = client.request(upstream_req).await?;

    // TTFB: time from request start to response headers received
    let wait_ms = start_instant.elapsed().as_millis() as u64;

    let resp_status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Stream response body through a channel for real-time forwarding
    let (tx, rx) = mpsc::channel::<Frame<Bytes>>(32);
    let upstream_body = upstream_resp.into_body();
    let record_headers = resp_headers.clone();

    tokio::spawn(async move {
        let mut upstream_body = upstream_body;
        let mut resp_buffer = Vec::new();

        while let Some(frame_result) = upstream_body.frame().await {
            match frame_result {
                Ok(frame) => {
                    if should_record {
                        if let Some(data) = frame.data_ref() {
                            resp_buffer.extend_from_slice(data);
                        }
                    }
                    if tx.send(frame).await.is_err() {
                        break; // Client disconnected
                    }
                }
                Err(e) => {
                    warn!("Upstream body error for {}: {}", uri, e);
                    break;
                }
            }
        }

        let elapsed_ms = start_instant.elapsed().as_millis() as u64;

        if should_record {
            let exchange = HttpExchange {
                request: ExchangeRequest {
                    method: req_method,
                    uri: req_uri,
                    headers: req_headers,
                    body: req_body_bytes,
                },
                response: ExchangeResponse {
                    status: resp_status,
                    headers: record_headers,
                    body: Bytes::from(resp_buffer),
                },
                started_at,
                wait_ms,
                elapsed_ms,
            };
            state.registry.on_exchange(&sid_for_record, &exchange);
        }
    });

    // Return streaming response immediately
    let mut response = hyper::Response::builder().status(resp_status);
    for (name, value) in &resp_headers {
        response = response.header(name, value);
    }
    Ok(response.body(ProxyBody::Streaming(ChannelBody { rx }))?)
}
