// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Integration tests for WebSocket proxying through the TLS interception layer.

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;

use super::helpers::{TestGateway, TestWebSocketBackend, TestWebSocketDropBackend};

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("gateway=debug")
        .with_test_writer()
        .try_init();
}

/// Helper: create a session with a client-generated ID, return it.
async fn create_session(api_client: &reqwest::Client, gw: &TestGateway) -> String {
    let session_id = uuid::Uuid::new_v4().to_string();
    let resp = api_client
        .post(gw.api_url("/api/v1/sessions"))
        .json(&serde_json::json!({ "id": session_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    session_id
}

/// Helper: poll HAR until the expected number of entries appear, then stop the session.
async fn stop_and_get_har(
    api_client: &reqwest::Client,
    gw: &TestGateway,
    session_id: &str,
    expected_entries: usize,
) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let resp = api_client
            .get(gw.api_url(&format!("/api/v1/sessions/{}/har?iteration=1", session_id)))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let har: serde_json::Value = resp.json().await.unwrap();
        let count = har["log"]["entries"].as_array().map_or(0, |a| a.len());
        if count >= expected_entries {
            // Stop the session
            let resp = api_client
                .post(gw.api_url(&format!("/api/v1/sessions/{}/stop", session_id)))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
            return har;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for {} HAR entries (got {})",
            expected_entries,
            count,
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Helper: establish a WebSocket connection through the proxy to the given backend port.
/// Returns the WebSocket stream ready for send/receive.
async fn connect_ws_through_proxy(
    gw: &TestGateway,
    session_id: &str,
    backend_port: u16,
) -> tokio_tungstenite::WebSocketStream<
    tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let proxy_addr = gw.proxy_addr;
    let ca_pem = gw.ca.ca_cert_pem();

    // CONNECT tunnel
    let mut proxy_tcp = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
    let connect_req = format!(
        "CONNECT localhost:{} HTTP/1.1\r\nHost: localhost:{}\r\nProxy-Authorization: Basic {}\r\n\r\n",
        backend_port,
        backend_port,
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{}:", session_id).as_bytes()
        ),
    );
    proxy_tcp.write_all(connect_req.as_bytes()).await.unwrap();

    let mut buf = vec![0u8; 4096];
    let mut total = 0;
    loop {
        let n = proxy_tcp.read(&mut buf[total..]).await.unwrap();
        total += n;
        let response = std::str::from_utf8(&buf[..total]).unwrap_or("");
        if response.contains("\r\n\r\n") {
            assert!(response.starts_with("HTTP/1.1 200"));
            break;
        }
    }

    // TLS handshake
    let mut root_store = rustls::RootCertStore::empty();
    let ca_certs = rustls_pemfile::certs(&mut ca_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for cert in ca_certs {
        root_store.add(cert).unwrap();
    }
    let tls_config = std::sync::Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let connector = tokio_rustls::TlsConnector::from(tls_config);
    let server_name = rustls::pki_types::ServerName::try_from("localhost".to_string()).unwrap();
    let tls_stream = connector.connect(server_name, proxy_tcp).await.unwrap();

    // WebSocket handshake
    let ws_uri = format!("wss://localhost:{}/ws", backend_port);
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .method("GET")
        .uri(&ws_uri)
        .header("Host", format!("localhost:{}", backend_port))
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .unwrap();

    let (ws_stream, resp) = tokio_tungstenite::client_async(ws_request, tls_stream)
        .await
        .expect("WebSocket handshake through proxy failed");

    assert_eq!(
        resp.status(),
        tokio_tungstenite::tungstenite::http::StatusCode::SWITCHING_PROTOCOLS
    );

    ws_stream
}

// -------------------------------------------------------------------------
// Test: WebSocket interception captures HAR with _webSocketMessages
// -------------------------------------------------------------------------

#[tokio::test]
async fn websocket_intercept_captures_har() {
    init_tracing();
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;

    let backend = TestWebSocketBackend::start(&gw.ca).await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    // Connect WebSocket through the proxy using manual CONNECT + TLS + WS handshake
    let proxy_addr = gw.proxy_addr;
    let backend_port = backend.addr.port();
    let ca_pem = gw.ca.ca_cert_pem();

    // Step 1: Establish CONNECT tunnel
    let proxy_tcp = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
    let connect_req = format!(
        "CONNECT localhost:{} HTTP/1.1\r\nHost: localhost:{}\r\nProxy-Authorization: Basic {}\r\n\r\n",
        backend_port,
        backend_port,
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{}:", session_id).as_bytes()
        ),
    );

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut proxy_tcp = proxy_tcp;
    proxy_tcp.write_all(connect_req.as_bytes()).await.unwrap();

    let mut buf = vec![0u8; 4096];
    let mut total = 0;
    loop {
        let n = proxy_tcp.read(&mut buf[total..]).await.unwrap();
        total += n;
        let response = std::str::from_utf8(&buf[..total]).unwrap_or("");
        if response.contains("\r\n\r\n") {
            assert!(
                response.starts_with("HTTP/1.1 200"),
                "Expected 200 from CONNECT, got: {}",
                response
            );
            break;
        }
    }

    // Step 2: TLS handshake over the tunnel
    let mut root_store = rustls::RootCertStore::empty();
    let ca_certs = rustls_pemfile::certs(&mut ca_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for cert in ca_certs {
        root_store.add(cert).unwrap();
    }
    let tls_config = std::sync::Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let connector = tokio_rustls::TlsConnector::from(tls_config);
    let server_name = rustls::pki_types::ServerName::try_from("localhost".to_string()).unwrap();
    let tls_stream = connector.connect(server_name, proxy_tcp).await.unwrap();

    // Step 3: WebSocket handshake over the intercepted TLS stream
    let ws_uri = format!("wss://localhost:{}/ws", backend_port);
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .method("GET")
        .uri(&ws_uri)
        .header("Host", format!("localhost:{}", backend_port))
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .unwrap();

    let (mut ws_stream, resp) = tokio_tungstenite::client_async(ws_request, tls_stream)
        .await
        .expect("WebSocket handshake through proxy failed");

    assert_eq!(
        resp.status(),
        tokio_tungstenite::tungstenite::http::StatusCode::SWITCHING_PROTOCOLS
    );

    // Step 4: Exchange some messages
    ws_stream
        .send(Message::Text("Hello".into()))
        .await
        .unwrap();
    let echo1 = ws_stream.next().await.unwrap().unwrap();
    assert_eq!(echo1, Message::Text("Hello".into()));

    ws_stream
        .send(Message::Text("World".into()))
        .await
        .unwrap();
    let echo2 = ws_stream.next().await.unwrap().unwrap();
    assert_eq!(echo2, Message::Text("World".into()));

    // Step 5: Close the WebSocket
    ws_stream.send(Message::Close(None)).await.unwrap();
    // Drain any remaining close frame
    while let Some(msg) = ws_stream.next().await {
        if msg.is_err() || msg.as_ref().map(|m| m.is_close()).unwrap_or(false) {
            break;
        }
    }

    // Step 6: Verify HAR capture
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);

    let entry = &entries[0];
    assert_eq!(entry["response"]["status"], 101);
    assert_eq!(entry["_resourceType"], "websocket");

    let ws_messages = entry["_webSocketMessages"].as_array().unwrap();
    // We sent 2 messages, got 2 echoes = 4 total messages recorded
    assert_eq!(ws_messages.len(), 4);

    // First message: client sends "Hello"
    assert_eq!(ws_messages[0]["type"], "send");
    assert_eq!(ws_messages[0]["opcode"], 1);
    assert_eq!(ws_messages[0]["data"], "Hello");

    // Second message: server echoes "Hello"
    assert_eq!(ws_messages[1]["type"], "receive");
    assert_eq!(ws_messages[1]["opcode"], 1);
    assert_eq!(ws_messages[1]["data"], "Hello");

    // Third message: client sends "World"
    assert_eq!(ws_messages[2]["type"], "send");
    assert_eq!(ws_messages[2]["opcode"], 1);
    assert_eq!(ws_messages[2]["data"], "World");

    // Fourth message: server echoes "World"
    assert_eq!(ws_messages[3]["type"], "receive");
    assert_eq!(ws_messages[3]["opcode"], 1);
    assert_eq!(ws_messages[3]["data"], "World");

    // Verify timestamps are ordered
    for i in 1..ws_messages.len() {
        let prev = ws_messages[i - 1]["time"].as_f64().unwrap();
        let curr = ws_messages[i]["time"].as_f64().unwrap();
        assert!(curr >= prev, "Timestamps should be non-decreasing");
    }
}

// -------------------------------------------------------------------------
// Test: Binary WebSocket frames are captured as base64 in HAR
// -------------------------------------------------------------------------

#[tokio::test]
async fn websocket_binary_frames_captured_as_base64() {
    init_tracing();
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;
    let backend = TestWebSocketBackend::start(&gw.ca).await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    let mut ws_stream =
        connect_ws_through_proxy(&gw, &session_id, backend.addr.port()).await;

    // Send binary data
    let binary_data: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD];
    ws_stream
        .send(Message::Binary(binary_data.clone().into()))
        .await
        .unwrap();
    let echo = ws_stream.next().await.unwrap().unwrap();
    assert_eq!(echo, Message::Binary(binary_data.clone().into()));

    // Close
    ws_stream.send(Message::Close(None)).await.unwrap();
    while let Some(msg) = ws_stream.next().await {
        if msg.is_err() || msg.as_ref().map(|m| m.is_close()).unwrap_or(false) {
            break;
        }
    }

    // Verify HAR
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    let ws_messages = entries[0]["_webSocketMessages"].as_array().unwrap();
    assert_eq!(ws_messages.len(), 2);

    // Sent binary message
    assert_eq!(ws_messages[0]["type"], "send");
    assert_eq!(ws_messages[0]["opcode"], 2);
    let expected_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &binary_data,
    );
    assert_eq!(ws_messages[0]["data"], expected_b64);

    // Received echo
    assert_eq!(ws_messages[1]["type"], "receive");
    assert_eq!(ws_messages[1]["opcode"], 2);
    assert_eq!(ws_messages[1]["data"], expected_b64);
}

// -------------------------------------------------------------------------
// Test: Upstream disconnect is handled gracefully and HAR is still captured
// -------------------------------------------------------------------------

#[tokio::test]
async fn websocket_upstream_disconnect_still_captures_har() {
    init_tracing();
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;

    // Start a backend that drops the connection after one message
    let backend = TestWebSocketDropBackend::start(&gw.ca).await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    let mut ws_stream =
        connect_ws_through_proxy(&gw, &session_id, backend.addr.port()).await;

    // Send a message — the server will echo it then drop the connection
    ws_stream
        .send(Message::Text("hello".into()))
        .await
        .unwrap();

    // Read the echo
    let echo = ws_stream.next().await.unwrap().unwrap();
    assert_eq!(echo, Message::Text("hello".into()));

    // The server drops — we should get a close or error
    let next = ws_stream.next().await;
    // Either None (stream ended), Close frame, or an error — all are acceptable
    match next {
        None => {} // stream ended cleanly
        Some(Ok(msg)) => assert!(msg.is_close()),
        Some(Err(_)) => {} // connection reset — expected
    }

    // Give the gateway a moment to flush the exchange
    tokio::time::sleep(Duration::from_millis(200)).await;

    // HAR should still have captured the messages exchanged before the drop
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["_resourceType"], "websocket");

    let ws_messages = entries[0]["_webSocketMessages"].as_array().unwrap();
    // At minimum, the sent "hello" and received echo should be captured
    assert!(
        ws_messages.len() >= 2,
        "Expected at least 2 messages, got {}",
        ws_messages.len()
    );
    assert_eq!(ws_messages[0]["type"], "send");
    assert_eq!(ws_messages[0]["data"], "hello");
    assert_eq!(ws_messages[1]["type"], "receive");
    assert_eq!(ws_messages[1]["data"], "hello");
}
