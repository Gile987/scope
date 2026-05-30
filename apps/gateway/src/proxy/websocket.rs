// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! WebSocket upgrade detection, bidirectional frame relay, and message recording.
//!
//! When the TLS interception layer detects an HTTP `Upgrade: websocket` request,
//! this module takes over:
//!   1. Forwards the upgrade request to the upstream server
//!   2. If upstream responds with 101 Switching Protocols, completes the upgrade
//!   3. Relays WebSocket frames bidirectionally between client and upstream
//!   4. Records all messages for plugin notification (HAR `_webSocketMessages`)
//!
//! The recording format follows Chrome DevTools' convention: each WebSocket
//! connection produces a single HAR entry with the upgrade handshake as
//! request/response and a `_webSocketMessages` array of `{type, time, opcode, data}`.

use std::sync::Arc;
use std::time::SystemTime;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;
use tracing::{debug, info};

use crate::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, SessionId};
use crate::proxy::handler::ProxyState;
use crate::session::InFlightGuard;

/// A recorded WebSocket message, following Chrome's `_webSocketMessages` format.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WsMessage {
    /// Direction: "send" (client→server) or "receive" (server→client)
    #[serde(rename = "type")]
    pub direction: String,
    /// Unix timestamp in seconds with millisecond precision
    pub time: f64,
    /// WebSocket opcode: 1 = text, 2 = binary
    pub opcode: u8,
    /// Message payload (text for opcode 1, base64 for opcode 2)
    pub data: String,
}

/// Returns true if the request is a WebSocket upgrade request.
pub fn is_websocket_upgrade<B>(req: &hyper::Request<B>) -> bool {
    let start = std::time::Instant::now();
    let has_upgrade = req
        .headers()
        .get(http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    let has_connection = req
        .headers()
        .get(http::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
        .unwrap_or(false);

    let result = has_upgrade && has_connection;
    if result {
        debug!(
            "WebSocket upgrade detected in {:?}",
            start.elapsed()
        );
    }
    result
}

/// Handle a WebSocket upgrade: forward the handshake to upstream, then relay
/// frames bidirectionally while recording messages for HAR.
///
/// This function takes ownership of the hyper request (which must be an upgrade
/// request) and the raw client IO (obtained after the HTTP layer yields via upgrade).
/// It connects to upstream, performs the WebSocket handshake, and relays until close.
pub async fn handle_websocket_upgrade(
    req: hyper::Request<Incoming>,
    domain: &str,
    port: u16,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> anyhow::Result<hyper::Response<Full<Bytes>>> {
    let started_at = chrono::Utc::now();

    // Keep the session alive for the entire WebSocket connection duration.
    let in_flight_guard =
        InFlightGuard::begin(state.session_manager.clone(), session_id.clone());
    if in_flight_guard.is_none() {
        anyhow::bail!("session {} no longer exists", session_id);
    }

    // Capture request metadata before consuming
    let (parts, _body) = req.into_parts();
    let req_method = parts.method.clone();
    let req_uri = parts.uri.clone();
    let mut req_headers = parts.headers.clone();

    // Build the full URI for logging
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

    // Build the WebSocket upgrade request for upstream.
    // Use tokio-tungstenite's client handshake with the existing TLS stream.
    let ws_uri = format!(
        "wss://{}:{}{}",
        domain,
        port,
        parts
            .uri
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/")
    );

    // Build a tungstenite request with the original headers (auth, extensions, etc.)
    let mut ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .method("GET")
        .uri(&ws_uri);

    for (key, value) in &req_headers {
        // Skip hop-by-hop headers that tungstenite manages itself
        let name = key.as_str().to_lowercase();
        if name == "host" || name == "sec-websocket-key" || name == "sec-websocket-version" {
            continue;
        }
        ws_request = ws_request.header(key, value);
    }

    let ws_request = ws_request
        .body(())
        .map_err(|e| anyhow::anyhow!("Failed to build WS request: {}", e))?;

    let request_instant = std::time::Instant::now();

    // Perform the WebSocket handshake with upstream
    let (upstream_ws, _response) =
        tokio_tungstenite::client_async(ws_request, upstream_tls).await?;

    let wait_ms = request_instant.elapsed().as_millis() as u64;

    debug!(
        "WebSocket handshake complete with upstream {} in {}ms",
        domain, wait_ms
    );

    // Build the 101 response to send back to the client.
    // The actual HTTP upgrade on the client side is handled by hyper's upgrade mechanism
    // in tls.rs — here we just return the response that indicates success.
    let resp = hyper::Response::builder()
        .status(http::StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::UPGRADE, "websocket")
        .header(http::header::CONNECTION, "Upgrade")
        .body(Full::new(Bytes::new()))?;

    // Spawn the frame relay task. It will run until the WebSocket connection closes.
    let session_id_owned = session_id.clone();
    let state_owned = state.clone();
    let domain_owned = domain.to_string();

    tokio::spawn(async move {
        let messages = relay_frames(upstream_ws, &domain_owned, &session_id_owned, &state_owned).await;

        let elapsed_ms = request_instant.elapsed().as_millis() as u64;

        // Serialize messages as the response body for the plugin exchange
        let messages_json = serde_json::to_vec(&messages).unwrap_or_default();

        // Build response headers matching 101 Switching Protocols
        let mut resp_headers = http::HeaderMap::new();
        resp_headers.insert(http::header::UPGRADE, "websocket".parse().unwrap());
        resp_headers.insert(http::header::CONNECTION, "Upgrade".parse().unwrap());

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: req_method,
                uri: req_uri,
                headers: req_headers,
                body: Bytes::new(),
            },
            response: ExchangeResponse {
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
            "WebSocket connection closed: {} session={} messages={} elapsed={}ms",
            domain_owned,
            session_id_owned,
            messages.len(),
            elapsed_ms
        );
    });

    Ok(resp)
}

/// Current Unix timestamp as f64 seconds with millisecond precision.
fn unix_timestamp_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// Relay WebSocket frames bidirectionally between client and upstream,
/// recording all messages. Returns the recorded messages when the connection closes.
///
/// Note: The `client_ws` parameter will be added when we wire this up with the
/// actual client IO from hyper's upgrade mechanism. For now, this function only
/// handles the upstream side — the client-side wiring happens in tls.rs.
async fn relay_frames<S>(
    upstream_ws: WebSocketStream<S>,
    domain: &str,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> Vec<WsMessage>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = (domain, session_id, state);

    let (_upstream_sink, mut upstream_stream) = upstream_ws.split();
    let mut messages = Vec::new();

    // For now, just drain the upstream until it closes.
    // Full bidirectional relay with client IO will be wired in the tls.rs integration.
    while let Some(msg_result) = upstream_stream.next().await {
        match msg_result {
            Ok(msg) => {
                if let Some(ws_msg) = message_to_record(&msg, "receive") {
                    messages.push(ws_msg);
                }
                if msg.is_close() {
                    break;
                }
            }
            Err(e) => {
                debug!("WebSocket upstream error for {}: {}", domain, e);
                break;
            }
        }
    }

    messages
}

/// Convert a tungstenite Message to a recorded WsMessage.
/// Returns None for control frames (ping/pong) that we don't record.
fn message_to_record(msg: &Message, direction: &str) -> Option<WsMessage> {
    match msg {
        Message::Text(text) => Some(WsMessage {
            direction: direction.to_string(),
            time: unix_timestamp_secs(),
            opcode: 1,
            data: text.to_string(),
        }),
        Message::Binary(data) => {
            use base64::Engine;
            Some(WsMessage {
                direction: direction.to_string(),
                time: unix_timestamp_secs(),
                opcode: 2,
                data: base64::engine::general_purpose::STANDARD.encode(data),
            })
        }
        Message::Close(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => None,
    }
}

/// Perform full bidirectional WebSocket relay between client and upstream,
/// recording all messages flowing in both directions.
///
/// This is the core relay function called after both sides have completed
/// the WebSocket handshake.
pub async fn relay_websocket_bidirectional<C, U>(
    client_ws: WebSocketStream<C>,
    upstream_ws: WebSocketStream<U>,
    domain: &str,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
) -> Vec<WsMessage>
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (mut client_sink, mut client_stream) = client_ws.split();
    let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();
    let mut messages = Vec::new();

    // Periodically touch the session to prevent reaping
    let touch_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    tokio::pin!(touch_interval);

    loop {
        tokio::select! {
            // Client → Upstream
            client_msg = client_stream.next() => {
                match client_msg {
                    Some(Ok(msg)) => {
                        if let Some(ws_msg) = message_to_record(&msg, "send") {
                            messages.push(ws_msg);
                        }
                        let is_close = msg.is_close();
                        if upstream_sink.send(msg).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        debug!("WebSocket client error for {}: {}", domain, e);
                        let _ = upstream_sink.send(Message::Close(None)).await;
                        break;
                    }
                    None => {
                        // Client stream ended
                        let _ = upstream_sink.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            // Upstream → Client
            upstream_msg = upstream_stream.next() => {
                match upstream_msg {
                    Some(Ok(msg)) => {
                        if let Some(ws_msg) = message_to_record(&msg, "receive") {
                            messages.push(ws_msg);
                        }
                        let is_close = msg.is_close();
                        if client_sink.send(msg).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        debug!("WebSocket upstream error for {}: {}", domain, e);
                        let _ = client_sink.send(Message::Close(None)).await;
                        break;
                    }
                    None => {
                        // Upstream stream ended
                        let _ = client_sink.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            // Periodic session touch
            _ = touch_interval.tick() => {
                state.session_manager.touch(session_id);
            }
        }
    }

    messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_websocket_upgrade() {
        let req = hyper::Request::builder()
            .method("GET")
            .uri("/v1/responses")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .body(())
            .unwrap();
        assert!(is_websocket_upgrade(&req));
    }

    #[test]
    fn detect_websocket_upgrade_case_insensitive() {
        let req = hyper::Request::builder()
            .method("GET")
            .uri("/ws")
            .header("connection", "upgrade")
            .header("upgrade", "WebSocket")
            .body(())
            .unwrap();
        assert!(is_websocket_upgrade(&req));
    }

    #[test]
    fn non_websocket_request() {
        let req = hyper::Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("Content-Type", "application/json")
            .body(())
            .unwrap();
        assert!(!is_websocket_upgrade(&req));
    }

    #[test]
    fn upgrade_without_connection_header() {
        let req = hyper::Request::builder()
            .method("GET")
            .uri("/ws")
            .header("Upgrade", "websocket")
            .body(())
            .unwrap();
        assert!(!is_websocket_upgrade(&req));
    }

    #[test]
    fn connection_upgrade_in_multi_value() {
        // Connection header can contain multiple comma-separated values
        let req = hyper::Request::builder()
            .method("GET")
            .uri("/ws")
            .header("Connection", "keep-alive, Upgrade")
            .header("Upgrade", "websocket")
            .body(())
            .unwrap();
        assert!(is_websocket_upgrade(&req));
    }

    #[test]
    fn text_message_recording() {
        let msg = Message::Text("hello".into());
        let recorded = message_to_record(&msg, "send").unwrap();
        assert_eq!(recorded.direction, "send");
        assert_eq!(recorded.opcode, 1);
        assert_eq!(recorded.data, "hello");
    }

    #[test]
    fn binary_message_recording() {
        let msg = Message::Binary(vec![0x01, 0x02, 0x03].into());
        let recorded = message_to_record(&msg, "receive").unwrap();
        assert_eq!(recorded.direction, "receive");
        assert_eq!(recorded.opcode, 2);
        // Should be base64 encoded
        assert_eq!(recorded.data, "AQID");
    }

    #[test]
    fn ping_pong_not_recorded() {
        assert!(message_to_record(&Message::Ping(vec![].into()), "send").is_none());
        assert!(message_to_record(&Message::Pong(vec![].into()), "receive").is_none());
    }
}
