# Gateway WebSocket Support

The AI gateway proxy supports WebSocket connections through its TLS interception layer. This enables recording of WebSocket traffic (e.g., OpenAI Responses API in streaming mode) alongside regular HTTP exchanges.

## Motivation

VS Code 1.118+ uses WebSocket mode for the OpenAI Responses API (`wss://api.openai.com/v1/responses`). The client opens a persistent WebSocket connection and exchanges JSON events (`response.create`, streamed response chunks, etc.) instead of using HTTP request/response pairs.

Without WebSocket support, the gateway's TLS MITM layer would reject the HTTP Upgrade request, breaking VS Code's ability to use these models.

## Architecture

```
Client (VS Code)
   │ CONNECT api.openai.com:443
   ▼
[Gateway Proxy - CONNECT handler]
   │ TLS MITM (forged cert)
   ▼
[Gateway TLS Interception Layer]
   │ Detects: Connection: Upgrade + Upgrade: websocket
   │ Forwards upgrade to upstream via TLS
   ▼
[Upstream (api.openai.com)]
   │ 101 Switching Protocols
   ▼
[Gateway] ← Bidirectional WebSocket frame relay → [Client]
   │
   └── Records frames as _webSocketMessages in HAR
```

### Flow

1. **Detection**: `is_websocket_upgrade()` checks for `Connection: Upgrade` + `Upgrade: websocket` headers in the intercepted HTTP request.
2. **Upstream Handshake**: Gateway connects to the upstream server via TLS and performs a WebSocket handshake using `tokio-tungstenite`.
3. **Client Upgrade**: Gateway returns HTTP 101 to the client, triggering hyper's upgrade mechanism.
4. **Frame Relay**: A background task relays WebSocket frames bidirectionally between client and upstream while recording each message.
5. **Recording**: On connection close, the recorded messages are reported to plugins as an `HttpExchange` with the messages serialized in the response body.

### Session Lifecycle

- An `InFlightGuard` is held for the entire WebSocket connection duration to prevent session reaping.
- The relay task periodically touches the session (every 30s) to prevent idle timeout.
- Only after the WebSocket closes is the exchange reported to plugins and the guard dropped.

## HAR Format

WebSocket connections are recorded in HAR following Chrome DevTools' convention.

### Entry Structure

Each WebSocket connection produces a single HAR entry:

```json
{
  "startedDateTime": "2024-01-15T10:30:00.000Z",
  "time": 5000.0,
  "_resourceType": "websocket",
  "request": {
    "method": "GET",
    "url": "wss://api.openai.com/v1/responses",
    "httpVersion": "HTTP/1.1",
    "headers": [
      { "name": "upgrade", "value": "websocket" },
      { "name": "connection", "value": "Upgrade" },
      { "name": "sec-websocket-key", "value": "..." },
      { "name": "sec-websocket-version", "value": "13" }
    ],
    "headersSize": -1,
    "bodySize": 0
  },
  "response": {
    "status": 101,
    "statusText": "Switching Protocols",
    "httpVersion": "HTTP/1.1",
    "headers": [
      { "name": "upgrade", "value": "websocket" },
      { "name": "connection", "value": "Upgrade" }
    ],
    "content": { "size": 0, "mimeType": "x-unknown" },
    "headersSize": -1,
    "bodySize": 0
  },
  "_webSocketMessages": [
    { "type": "send", "time": 1705312200.123, "opcode": 1, "data": "{\"type\":\"response.create\",...}" },
    { "type": "receive", "time": 1705312200.456, "opcode": 1, "data": "{\"type\":\"response.created\",...}" },
    { "type": "receive", "time": 1705312200.789, "opcode": 1, "data": "{\"type\":\"response.output_item.added\",...}" }
  ]
}
```

### `_webSocketMessages` Fields

| Field | Values | Description |
|-------|--------|-------------|
| `type` | `"send"` / `"receive"` | Direction: client→server or server→client |
| `time` | Unix timestamp (f64) | Seconds since epoch with millisecond precision |
| `opcode` | `1` (text) / `2` (binary) | WebSocket frame opcode |
| `data` | string | Message payload (text for opcode 1, base64 for opcode 2) |

### What's NOT Recorded

- Ping/pong frames (control frames, not application data)
- Close frames (connection lifecycle, not content)

This matches Chrome DevTools behavior.

## Plugin API Mapping

The gateway's plugin system receives WebSocket connections as `HttpExchange`:

- `exchange.request`: The HTTP Upgrade request (method=GET, URI, headers including WS headers, empty body)
- `exchange.response`: Status 101, Upgrade headers, **body = JSON-serialized `_webSocketMessages` array**
- `exchange.started_at`: When the upgrade request was sent
- `exchange.wait_ms`: Time to receive 101 from upstream
- `exchange.elapsed_ms`: Total WebSocket connection lifetime

The HAR plugin detects WebSocket exchanges (status 101 + `Upgrade: websocket`) and:
1. Sets `_resourceType: "websocket"` on the entry
2. Deserializes the response body into `_webSocketMessages`
3. Sets response content size to 0 (messages are in the custom field, not the content)

## Cross-Cutting Feature Parity

The WebSocket path supports all protocol-agnostic features available on the HTTPS and SSE paths:

| Feature | HTTPS/SSE | WebSocket | Notes |
|---------|:---------:|:---------:|-------|
| Session validation (`InFlightGuard`) | ✅ | ✅ | Guard held for entire WS connection lifetime |
| `on_request` plugin hook (header mutation, token injection) | ✅ | ✅ | Called before upstream WS handshake |
| `on_exchange` plugin hook (HAR recording, custom plugins) | ✅ | ✅ | Called after WS close with all recorded messages |
| Iteration tracking | ✅ | ✅ | Iteration read at exchange report time |
| Session touch (prevents idle reaping) | ✅ | ✅ | Periodic 30s touch during long-lived WS connections |
| `InFlightGuard` drop (re-enables reaping) | ✅ | ✅ | Dropped after `on_exchange` notification |
| Upstream TLS (real cert validation) | ✅ | ✅ | Same `upstream_tls_config` used for WS connections |
| Timing (`started_at`, `wait_ms`, `elapsed_ms`) | ✅ | ✅ | `elapsed_ms` = total WS connection lifetime |
| URL pattern matching (passthrough) | ✅ | ✅ | Handled at CONNECT level, before protocol detection |

The only addition specific to WebSocket is the **periodic 30s session touch** during the relay loop, since WS connections are long-lived whereas HTTP responses complete quickly enough that a single touch on completion suffices.

## Implementation Files

| File | Purpose |
|------|---------|
| `src/proxy/websocket.rs` | WebSocket detection, bidirectional relay, message recording |
| `src/proxy/tls.rs` | Integration point: `handle_websocket_in_tls()` function |
| `src/plugins/har/types.rs` | `HarWebSocketMessage` struct, `_webSocketMessages` and `_resourceType` fields |
| `src/plugins/har/writer.rs` | WebSocket-aware `exchange_to_har_entry()` logic |

## Dependencies

- `tokio-tungstenite` v0.26: WebSocket frame parsing/encoding, async client/server
- `futures-util`: Stream/Sink combinators for bidirectional relay
