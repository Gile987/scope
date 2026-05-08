// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Shared body types and streaming helpers used by both the plain HTTP
//! forwarding path and the TLS interception relay.
//!
//! Extracts the common pattern: an mpsc-channel-backed body that streams
//! response frames to the client in real time while a background task
//! accumulates a copy for HAR recording and plugin notification.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Frame;
use tokio::sync::mpsc;
use tracing::warn;

use crate::plugin::{ExchangeRequest, ExchangeResponse, HttpExchange, SessionId};
use crate::proxy::handler::ProxyState;

/// Streaming response body backed by an mpsc channel.
/// Upstream response frames are forwarded through this channel to the client
/// in real time, while a background task simultaneously buffers them for
/// plugin notification.
pub(crate) struct ChannelBody {
    pub rx: mpsc::Receiver<Frame<Bytes>>,
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

/// Response body — either buffered (error responses, CONNECT ack) or
/// streaming (forwarded upstream responses via channel).
pub(crate) enum StreamingBody {
    Buffered(Full<Bytes>),
    Streaming(ChannelBody),
}

impl hyper::body::Body for StreamingBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.get_mut() {
            StreamingBody::Buffered(inner) => Pin::new(inner).poll_frame(cx),
            StreamingBody::Streaming(inner) => Pin::new(inner).poll_frame(cx),
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            StreamingBody::Buffered(inner) => inner.is_end_stream(),
            StreamingBody::Streaming(_) => false,
        }
    }
}

/// Metadata captured before forwarding, used to build the `HttpExchange`
/// after the response body completes.
pub(crate) struct ExchangeContext {
    pub req_method: http::Method,
    pub req_uri: http::Uri,
    pub req_headers: http::HeaderMap,
    pub req_body: Bytes,
    pub resp_status: http::StatusCode,
    pub resp_headers: http::HeaderMap,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub wait_ms: u64,
    pub request_instant: std::time::Instant,
    pub session_id: SessionId,
}

/// Spawn a background task that streams frames from `upstream_body` to the
/// client via `tx`, buffers a copy for HAR recording, and notifies plugins
/// when the body completes.
///
/// `on_complete` is called after the body is fully consumed (before plugin
/// notification) — used by the TLS path to drop the upstream sender and
/// touch the session.
pub(crate) fn spawn_stream_and_record<B, F>(
    upstream_body: B,
    tx: mpsc::Sender<Frame<Bytes>>,
    ctx: ExchangeContext,
    state: Arc<ProxyState>,
    log_target: String,
    on_complete: F,
) where
    B: hyper::body::Body<Data = Bytes> + Send + 'static,
    B::Error: std::fmt::Display + Send,
    F: FnOnce() + Send + 'static,
{
    tokio::spawn(async move {
        let mut resp_buffer = Vec::new();

        // Pin the body so we can call frame()
        let mut upstream_body = std::pin::pin!(upstream_body);

        while let Some(frame_result) = upstream_body.as_mut().frame().await {
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
                    warn!("Upstream body error for {}: {}", log_target, e);
                    break;
                }
            }
        }

        let elapsed_ms = ctx.request_instant.elapsed().as_millis() as u64;

        on_complete();

        let exchange = HttpExchange {
            request: ExchangeRequest {
                method: ctx.req_method,
                uri: ctx.req_uri,
                headers: ctx.req_headers,
                body: ctx.req_body,
            },
            response: ExchangeResponse {
                status: ctx.resp_status,
                headers: ctx.resp_headers,
                body: Bytes::from(resp_buffer),
            },
            started_at: ctx.started_at,
            wait_ms: ctx.wait_ms,
            elapsed_ms,
        };

        // Read iteration from session manager before notifying plugins.
        let iteration = state
            .session_manager
            .get_iteration(&ctx.session_id)
            .await
            .unwrap_or(None)
            .unwrap_or(0);

        state
            .registry
            .on_exchange(&ctx.session_id, &exchange, iteration)
            .await;
    });
}

/// Build a streaming `hyper::Response` from status, headers, and channel receiver.
pub(crate) fn streaming_response(
    status: http::StatusCode,
    headers: &http::HeaderMap,
    rx: mpsc::Receiver<Frame<Bytes>>,
) -> anyhow::Result<hyper::Response<StreamingBody>> {
    let mut resp = hyper::Response::builder().status(status);
    for (key, value) in headers {
        resp = resp.header(key, value);
    }
    Ok(resp.body(StreamingBody::Streaming(ChannelBody { rx }))?)
}
