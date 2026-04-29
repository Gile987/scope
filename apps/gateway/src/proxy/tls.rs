// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! TLS man-in-the-middle (MITM) interception layer.
//!
//! When the proxy decides to intercept a CONNECT tunnel, this module performs
//! a two-phase TLS handshake:
//!   1. **Client side**: Accept the client's TLS using a leaf cert forged by our CA
//!      for the target domain. The client trusts this because it trusts our CA root.
//!   2. **Upstream side**: Open a real TLS connection to the upstream server using
//!      the system root certificates.
//!
//! HTTP/1.1 traffic is then relayed between the two TLS sessions while capturing
//! request/response pairs for plugin notification. Response bodies are streamed
//! frame-by-frame to the client (important for SSE) while a background task
//! accumulates a copy for HAR recording.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, warn};

use crate::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, SessionId};
use crate::proxy::handler::ProxyState;

/// Streaming response body for TLS-intercepted requests, backed by an mpsc channel.
/// Frames from upstream are forwarded in real time while a background task buffers
/// them for HAR recording.
struct RelayBody {
    rx: mpsc::Receiver<Frame<Bytes>>,
}

impl hyper::body::Body for RelayBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.get_mut().rx.poll_recv(cx).map(|opt| opt.map(Ok))
    }
}

/// Response body for relayed requests — either streaming (normal) or buffered (errors).
enum RelayResponseBody {
    Buffered(Full<Bytes>),
    Streaming(RelayBody),
}

impl hyper::body::Body for RelayResponseBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.get_mut() {
            RelayResponseBody::Buffered(inner) => Pin::new(inner).poll_frame(cx),
            RelayResponseBody::Streaming(inner) => Pin::new(inner).poll_frame(cx),
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            RelayResponseBody::Buffered(inner) => inner.is_end_stream(),
            RelayResponseBody::Streaming(_) => false,
        }
    }
}

/// Intercept a TLS connection: MITM with forged cert, relay, and notify plugins.
pub async fn intercept_tls<S>(
    client_io: S,
    host: &str,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Parse host without port for cert generation
    let domain = host.split(':').next().unwrap_or(host);
    let port: u16 = host
        .split(':')
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(443);

    // Phase 1: Present a forged leaf cert to the client. The cert is signed by our
    // CA and cached per domain, so repeated connections to the same host are fast.
    let server_config = state.ca.server_config_for_domain(domain)?;
    let acceptor = TlsAcceptor::from(server_config);

    // The client thinks it's talking to the real server — our forged cert matches the domain.
    let client_tls = acceptor.accept(client_io).await?;
    debug!("TLS handshake complete with client for {}", domain);

    // Handle HTTP/1.1 over the intercepted TLS connection
    let io = TokioIo::new(client_tls);

    let state_clone = state.clone();
    let session_id_clone = session_id.clone();
    let domain_owned = domain.to_string();
    let port_owned = port;

    hyper::server::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let state = state_clone.clone();
                let sid = session_id_clone.clone();
                let domain = domain_owned.clone();
                async move {
                    relay_request(req, &domain, port_owned, &sid, &state).await
                }
            }),
        )
        .await?;

    Ok(())
}

/// Relay a single request to the upstream, capture exchange, notify plugins.
async fn relay_request(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> Result<hyper::Response<RelayResponseBody>, hyper::Error> {
    match relay_request_inner(req, domain, port, session_id, state).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            warn!("Relay error for {}: {}", domain, e);
            Ok(hyper::Response::builder()
                .status(502)
                .body(RelayResponseBody::Buffered(Full::new(Bytes::from(format!("Upstream error: {}", e)))))
                .unwrap())
        }
    }
}

async fn relay_request_inner(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<RelayResponseBody>> {
    let started_at = chrono::Utc::now();

    // Capture request details
    let (parts, body) = req.into_parts();
    let req_body = body.collect().await?.to_bytes();

    let req_method = parts.method.clone();
    let req_uri = parts.uri.clone();
    let req_headers = parts.headers.clone();

    // Build the full URI for the upstream request
    let uri_str = format!("https://{}:{}{}", domain, port, parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/"));
    let upstream_uri: hyper::Uri = uri_str.parse()?;

    // Phase 2: Connect to the real upstream with genuine TLS.
    let upstream_tcp = TcpStream::connect(format!("{}:{}", domain, port)).await?;

    let connector = TlsConnector::from(state.upstream_tls_config.clone());

    let server_name = rustls::pki_types::ServerName::try_from(domain.to_string())?;
    let upstream_tls = connector.connect(server_name, upstream_tcp).await?;

    let io = TokioIo::new(upstream_tls);
    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(io)
        .await?;

    tokio::spawn(async move {
        if let Err(e) = conn.await {
            debug!("Upstream connection ended: {}", e);
        }
    });

    // Build upstream request
    let mut upstream_req = hyper::Request::builder()
        .method(&parts.method)
        .uri(upstream_uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/"))
        .version(parts.version);

    for (key, value) in &parts.headers {
        upstream_req = upstream_req.header(key, value);
    }

    let upstream_req = upstream_req.body(Full::new(req_body.clone()))?;

    // Start timing from request send (after connect/TLS handshake)
    let request_instant = std::time::Instant::now();

    // Send to upstream
    let upstream_resp = sender.send_request(upstream_req).await?;
    let wait_ms = request_instant.elapsed().as_millis() as u64;

    let resp_status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Stream response body through a channel: frames are forwarded to the client
    // in real time (critical for SSE) while a background task accumulates a copy
    // for HAR recording and plugin notification.
    let (tx, rx) = mpsc::channel::<Frame<Bytes>>(32);
    let upstream_body = upstream_resp.into_body();
    let record_headers = resp_headers.clone();
    let session_id_owned = session_id.clone();
    let state_owned = state.clone();
    let domain_for_log = domain.to_string();

    tokio::spawn(async move {
        let mut upstream_body = upstream_body;
        let mut resp_buffer = Vec::new();

        while let Some(frame_result) = upstream_body.frame().await {
            match frame_result {
                Ok(frame) => {
                    if let Some(data) = frame.data_ref() {
                        resp_buffer.extend_from_slice(data);
                    }
                    if tx.send(frame).await.is_err() {
                        break; // Client disconnected
                    }
                }
                Err(e) => {
                    warn!("Upstream body error for {}: {}", domain_for_log, e);
                    break;
                }
            }
        }

        let elapsed_ms = request_instant.elapsed().as_millis() as u64;

        // Drop the HTTP sender to close the upstream connection. Without this,
        // HTTP/1.1 keepalive holds the TCP+TLS fd open until the upstream's idle
        // timeout fires — leaking fds under load.
        drop(sender);

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: req_method,
                uri: req_uri,
                headers: req_headers,
                body: req_body,
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

        state_owned.session_manager.touch(&session_id_owned);
        state_owned.registry.on_exchange(&session_id_owned, &exchange);
    });

    // Return streaming response immediately
    let mut resp = hyper::Response::builder().status(resp_status);
    for (key, value) in &resp_headers {
        resp = resp.header(key, value);
    }
    Ok(resp.body(RelayResponseBody::Streaming(RelayBody { rx }))?)
}
