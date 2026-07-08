// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! WebSocket upgrade detection, bidirectional frame relay, and message recording.
//!
//! When the TLS interception layer detects an HTTP `Upgrade: websocket` request,
//! it delegates to `handle_websocket_in_tls()` (in `tls.rs`) which uses this module's
//! `relay_websocket_bidirectional()` to relay frames while recording messages.
//!
//! The recording format follows Chrome DevTools' convention: each WebSocket
//! connection produces a single HAR entry with the upgrade handshake as
//! request/response and a `_webSocketMessages` array of `{type, time, opcode, data}`.

use std::sync::Arc;
use std::time::SystemTime;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;
use tracing::debug;

use crate::plugin::SessionId;
use crate::proxy::handler::ProxyState;

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

    has_upgrade && has_connection
}

/// Current Unix timestamp as f64 seconds with millisecond precision.
fn unix_timestamp_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
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
        Message::Binary(data) => Some(WsMessage {
            direction: direction.to_string(),
            time: unix_timestamp_secs(),
            opcode: 2,
            data: base64::engine::general_purpose::STANDARD.encode(data),
        }),
        Message::Close(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => None,
    }
}

/// Resolve once the session's cancellation signal becomes `true`. If the
/// sender has been dropped (e.g. a placeholder receiver for a session that no
/// longer exists), this parks forever so the relay's select branch never wins.
async fn wait_for_cancel(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Perform full bidirectional WebSocket relay between client and upstream,
/// recording all messages flowing in both directions.
///
/// This is the core relay function called after both sides have completed
/// the WebSocket handshake.
///
/// The relay also watches `cancel_rx`: when the session is explicitly stopped
/// the loop breaks and returns the messages captured so far. This is essential
/// for agents (e.g. Codex) that keep a single WebSocket open for the whole
/// turn — the worker stops the session before the socket closes, so without
/// cancellation the `_webSocketMessages` would never be flushed to the HAR.
pub async fn relay_websocket_bidirectional<C, U>(
    client_ws: WebSocketStream<C>,
    upstream_ws: WebSocketStream<U>,
    domain: &str,
    session_id: &SessionId,
    state: &Arc<ProxyState>,
    mut cancel_rx: watch::Receiver<bool>,
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
            // Session stopped — close both sides and flush what we have.
            _ = wait_for_cancel(&mut cancel_rx) => {
                debug!("WebSocket relay for {} cancelled by session stop", domain);
                let _ = upstream_sink.send(Message::Close(None)).await;
                let _ = client_sink.send(Message::Close(None)).await;
                break;
            }
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
