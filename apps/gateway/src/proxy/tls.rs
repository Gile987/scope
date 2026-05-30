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
//!
//! WebSocket upgrades are detected and handled by the `websocket` module, which
//! performs a full bidirectional frame relay with message recording.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, info, warn};

use crate::plugin::SessionId;
use crate::proxy::body::{
    spawn_stream_and_record, streaming_response, ExchangeContext, StreamingBody,
};
use crate::proxy::handler::ProxyState;
use crate::proxy::websocket;

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
                async move { relay_request(req, &domain, port_owned, &sid, &state).await }
            }),
        )
        .with_upgrades()
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
) -> Result<hyper::Response<StreamingBody>, hyper::Error> {
    match relay_request_inner(req, domain, port, session_id, state).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            warn!("Relay error for {}: {}", domain, e);
            Ok(hyper::Response::builder()
                .status(502)
                .body(StreamingBody::Buffered(Full::new(Bytes::from(format!(
                    "Upstream error: {}",
                    e
                )))))
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
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    // Detect WebSocket upgrade requests and handle them separately.
    if websocket::is_websocket_upgrade(&req) {
        return handle_websocket_in_tls(req, domain, port, session_id, state).await;
    }

    let started_at = chrono::Utc::now();

    // Mark this request as in flight on the session. The guard's drop
    // decrements the counter and touches the session — this prevents the
    // background reaper from deleting the session while a long-running
    // streaming response (e.g. a multi-minute Claude completion) is in
    // flight. See #818.
    //
    // The guard is moved into the response-completion callback below so the
    // counter stays elevated until the entire response body has streamed to
    // the client, not just until the upstream headers arrive.
    let in_flight_guard =
        crate::session::InFlightGuard::begin(state.session_manager.clone(), session_id.clone());
    if in_flight_guard.is_none() {
        anyhow::bail!("session {} no longer exists", session_id);
    }

    // Capture request details
    let (parts, body) = req.into_parts();
    let req_body = body.collect().await?.to_bytes();

    let req_method = parts.method.clone();
    let req_uri = parts.uri.clone();
    let mut req_headers = parts.headers.clone();

    // Build the full URI for the upstream request
    let uri_str = format!(
        "https://{}:{}{}",
        domain,
        port,
        parts
            .uri
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
    );
    let upstream_uri: hyper::Uri = uri_str.parse()?;

    // Give plugins a chance to mutate headers (e.g. refresh auth tokens)
    state
        .registry
        .on_request(session_id, &upstream_uri, &mut req_headers)
        .await?;

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
        .uri(
            upstream_uri
                .path_and_query()
                .map(|pq| pq.as_str())
                .unwrap_or("/"),
        )
        .version(parts.version);

    for (key, value) in &req_headers {
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

    let (tx, rx) = mpsc::channel::<Frame<Bytes>>(32);
    let upstream_body = upstream_resp.into_body();
    let session_id_owned = session_id.clone();

    let ctx = ExchangeContext {
        req_method,
        req_uri,
        req_headers,
        req_body,
        resp_status,
        resp_headers: resp_headers.clone(),
        started_at,
        wait_ms,
        request_instant,
        session_id: session_id_owned.clone(),
    };

    let state_owned = state.clone();
    spawn_stream_and_record(
        upstream_body,
        tx,
        ctx,
        state.clone(),
        domain.to_string(),
        move || {
            // Drop the HTTP sender to close the upstream connection. Without this,
            // HTTP/1.1 keepalive holds the TCP+TLS fd open until the upstream's idle
            // timeout fires — leaking fds under load.
            drop(sender);
            state_owned.session_manager.touch(&session_id_owned);
            // Drop the in-flight guard last: this decrements the counter
            // and touches the session, allowing the reaper to consider it
            // again on its next tick.
            drop(in_flight_guard);
        },
    );

    streaming_response(resp_status, &resp_headers, rx)
}

/// Handle a WebSocket upgrade request within the TLS interception layer.
///
/// Flow:
/// 1. Connect to upstream via TLS and perform WebSocket handshake
/// 2. Return 101 to client (triggers hyper's upgrade mechanism)
/// 3. After upgrade, get raw client IO and wrap it as WebSocket
/// 4. Relay frames bidirectionally while recording messages
/// 5. On close, notify plugins with the recorded exchange
async fn handle_websocket_in_tls(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    let started_at = chrono::Utc::now();

    // Keep the session alive for the entire WebSocket connection duration.
    let in_flight_guard =
        crate::session::InFlightGuard::begin(state.session_manager.clone(), session_id.clone());
    if in_flight_guard.is_none() {
        anyhow::bail!("session {} no longer exists", session_id);
    }

    // Capture request metadata
    let req_method = req.method().clone();
    let req_uri = req.uri().clone();
    let mut req_headers = req.headers().clone();

    let uri_str = format!(
        "https://{}:{}{}",
        domain,
        port,
        req.uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
    );

    info!(
        "WebSocket upgrade: {} session={}",
        uri_str, session_id
    );

    // Give plugins a chance to mutate headers (e.g. refresh auth tokens)
    let upstream_uri: hyper::Uri = uri_str.parse()?;
    state
        .registry
        .on_request(session_id, &upstream_uri, &mut req_headers)
        .await?;

    // Connect to upstream via TLS
    let upstream_tcp = TcpStream::connect(format!("{}:{}", domain, port)).await?;
    let connector = TlsConnector::from(state.upstream_tls_config.clone());
    let server_name = rustls::pki_types::ServerName::try_from(domain.to_string())?;
    let upstream_tls = connector.connect(server_name, upstream_tcp).await?;

    // Build the WebSocket URI for the upstream connection
    let ws_uri = format!(
        "wss://{}:{}{}",
        domain,
        port,
        req.uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
    );

    // Use tungstenite's IntoClientRequest which generates proper WS handshake headers.
    // Then add any custom headers from the original request (e.g. auth tokens).
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut ws_request = ws_uri.into_client_request()?;

    for (key, value) in &req_headers {
        // Skip headers that tungstenite already set for the WS handshake
        let name = key.as_str().to_lowercase();
        if matches!(
            name.as_str(),
            "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
                | "upgrade"
                | "connection"
                | "host"
        ) {
            continue;
        }
        ws_request.headers_mut().insert(key.clone(), value.clone());
    }

    let request_instant = std::time::Instant::now();

    // Perform the WebSocket handshake with upstream
    let (upstream_ws, _ws_response) =
        tokio_tungstenite::client_async(ws_request, upstream_tls).await
            .map_err(|e| anyhow::anyhow!("WebSocket upstream handshake failed: {}", e))?;

    let wait_ms = request_instant.elapsed().as_millis() as u64;

    debug!(
        "WebSocket handshake complete with upstream {} in {}ms",
        domain, wait_ms
    );

    // Return 101 to the client. hyper will trigger the upgrade mechanism,
    // giving us access to the raw client IO afterward.
    let resp = hyper::Response::builder()
        .status(http::StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::UPGRADE, "websocket")
        .header(http::header::CONNECTION, "Upgrade")
        // Sec-WebSocket-Accept is required for a valid WS handshake response.
        // Compute it from the client's Sec-WebSocket-Key.
        .header(
            "Sec-WebSocket-Accept",
            compute_websocket_accept(
                req.headers()
                    .get("Sec-WebSocket-Key")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            ),
        )
        .body(StreamingBody::Buffered(Full::new(Bytes::new())))?;

    // Spawn a task that waits for the upgrade, then relays WebSocket frames.
    let session_id_owned = session_id.clone();
    let state_owned = state.clone();
    let domain_owned = domain.to_string();

    tokio::spawn(async move {
        // Wait for hyper to complete the upgrade and give us raw client IO.
        let upgraded = match hyper::upgrade::on(req).await {
            Ok(upgraded) => upgraded,
            Err(e) => {
                warn!("WebSocket client upgrade failed: {}", e);
                return;
            }
        };

        // Wrap the client's raw IO as a WebSocket stream (server role — no masking).
        let client_ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
            hyper_util::rt::TokioIo::new(upgraded),
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;

        // Relay frames bidirectionally, recording all messages.
        let messages = websocket::relay_websocket_bidirectional(
            client_ws,
            upstream_ws,
            &domain_owned,
            &session_id_owned,
            &state_owned,
        )
        .await;

        let elapsed_ms = request_instant.elapsed().as_millis() as u64;

        // Serialize messages as the response body for the plugin exchange
        let messages_json = serde_json::to_vec(&messages).unwrap_or_default();

        // Build response headers matching 101 Switching Protocols
        let mut resp_headers = http::HeaderMap::new();
        resp_headers.insert(http::header::UPGRADE, "websocket".parse().unwrap());
        resp_headers.insert(http::header::CONNECTION, "Upgrade".parse().unwrap());

        let exchange = crate::plugin::HttpExchange {
            request: crate::plugin::ExchangeRequest {
                method: req_method,
                uri: req_uri,
                headers: req_headers,
                body: Bytes::new(),
            },
            response: crate::plugin::ExchangeResponse {
                status: http::StatusCode::SWITCHING_PROTOCOLS,
                headers: resp_headers,
                body: Bytes::from(messages_json),
            },
            started_at,
            wait_ms,
            elapsed_ms,
        };

        // Read iteration from session manager before notifying plugins.
        let iteration = state_owned
            .session_manager
            .get_iteration(&session_id_owned)
            .await
            .unwrap_or(None)
            .unwrap_or(0);

        state_owned
            .registry
            .on_exchange(&session_id_owned, &exchange, iteration)
            .await;

        // Drop in-flight guard last to allow reaper to consider the session again.
        drop(in_flight_guard);

        info!(
            "WebSocket closed: {} session={} messages={} elapsed={}ms",
            domain_owned,
            session_id_owned,
            messages.len(),
            elapsed_ms
        );
    });

    Ok(resp)
}

/// Compute the Sec-WebSocket-Accept value from a Sec-WebSocket-Key.
/// Per RFC 6455: concatenate key + GUID, SHA-1 hash, base64 encode.
fn compute_websocket_accept(key: &str) -> String {
    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes())
}
