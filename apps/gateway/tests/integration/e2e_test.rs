// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::time::{Duration, Instant};

use super::helpers::{TestGateway, TestHttpBackend, TestHttpsBackend, TestSseBackend};
use tempfile::TempDir;

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("gateway=debug")
        .with_test_writer()
        .try_init();
}

/// Build a reqwest client that uses the proxy and trusts the gateway's CA.
/// The session_id is sent as proxy basic auth (username) so the gateway can
/// resolve the session from the Proxy-Authorization header.
fn proxy_client(
    proxy_addr: std::net::SocketAddr,
    ca_pem: &str,
    session_id: &str,
) -> reqwest::Client {
    let ca_cert = reqwest::tls::Certificate::from_pem(ca_pem.as_bytes()).unwrap();
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}@{}", session_id, proxy_addr)).unwrap())
        .add_root_certificate(ca_cert)
        .build()
        .unwrap()
}

/// Helper: create a session, return session ID.
async fn create_session(api_client: &reqwest::Client, gw: &TestGateway) -> String {
    let resp = api_client
        .post(gw.api_url("/api/v1/sessions"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    body["id"].as_str().unwrap().to_string()
}

/// Helper: stop a session.
async fn stop_session(api_client: &reqwest::Client, gw: &TestGateway, session_id: &str) {
    let resp = api_client
        .post(gw.api_url(&format!("/api/v1/sessions/{}/stop", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// Helper: get HAR entries.
async fn get_har(
    api_client: &reqwest::Client,
    gw: &TestGateway,
    session_id: &str,
) -> serde_json::Value {
    let resp = api_client
        .get(gw.api_url(&format!("/api/v1/sessions/{}/har", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

/// Helper: poll HAR until the expected number of entries appear, then stop the session.
/// Returns the HAR JSON. Panics if entries don't appear within 2 seconds.
async fn stop_and_get_har(
    api_client: &reqwest::Client,
    gw: &TestGateway,
    session_id: &str,
    expected_entries: usize,
) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let har = get_har(api_client, gw, session_id).await;
        let count = har["log"]["entries"].as_array().map_or(0, |a| a.len());
        if count >= expected_entries {
            stop_session(api_client, gw, session_id).await;
            return har;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for {} HAR entries (got {})",
            expected_entries,
            count,
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// -------------------------------------------------------------------------
// Test 1: End-to-end HTTPS interception → HAR captured
// -------------------------------------------------------------------------

#[tokio::test]
async fn https_intercept_captures_har() {
    init_tracing();
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;

    let backend = TestHttpsBackend::start(
        &gw.ca,
        Box::new(|_path| {
            Box::pin(async {
                (
                    200u16,
                    vec![("content-type".into(), "application/json".into())],
                    br#"{"ok":true}"#.to_vec(),
                )
            })
        }),
    )
    .await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    // Request through the proxy (CONNECT → TLS MITM → backend)
    let client = proxy_client(gw.proxy_addr, &gw.ca.ca_cert_pem(), &session_id);
    let resp = client
        .get(format!(
            "https://localhost:{}/api/test",
            backend.addr.port()
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], true);

    // Poll until the exchange is recorded, then stop the session.
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);

    let entry = &entries[0];
    assert_eq!(entry["response"]["status"], 200);

    // Body should be captured (either as text or base64)
    let response_content = &entry["response"]["content"];
    let has_body = response_content["text"].as_str().is_some()
        || response_content["encoding"].as_str() == Some("base64");
    assert!(has_body, "HAR should capture response body");
}

// -------------------------------------------------------------------------
// Test 2: SSE streaming through TLS MITM
// -------------------------------------------------------------------------

#[tokio::test]
async fn sse_streaming_not_buffered() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;

    let events = vec!["event1".into(), "event2".into(), "event3".into()];
    let backend = TestSseBackend::start(&gw.ca, events.clone(), Duration::from_millis(80)).await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    let client = proxy_client(gw.proxy_addr, &gw.ca.ca_cert_pem(), &session_id);
    let resp = client
        .get(format!("https://localhost:{}/events", backend.addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "text/event-stream"
    );

    // Read the streaming body, tracking when each chunk arrives.
    let start = Instant::now();
    let mut first_chunk_time = None;
    let mut collected = String::new();

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        if first_chunk_time.is_none() {
            first_chunk_time = Some(start.elapsed());
        }
        collected.push_str(&String::from_utf8_lossy(&chunk));
    }
    let total_time = start.elapsed();

    // The first event should arrive quickly (streaming, not buffered)
    let first = first_chunk_time.unwrap();
    assert!(
        first < Duration::from_millis(200),
        "First chunk took {:?} — response is being buffered instead of streamed",
        first
    );

    // Total time should reflect the delays between events (~160ms for 3 events with 80ms gaps)
    assert!(
        total_time >= Duration::from_millis(120),
        "Total time {:?} too fast — events should have delays",
        total_time
    );

    // All 3 events should be in the collected output
    for event in &events {
        assert!(
            collected.contains(event),
            "Missing event '{}' in: {}",
            event,
            collected
        );
    }

    // Poll until the SSE exchange is recorded, then stop the session.
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["response"]["status"], 200);
}

// -------------------------------------------------------------------------
// Test 3: Plain HTTP forwarding with recording
// -------------------------------------------------------------------------

#[tokio::test]
async fn plain_http_forwarding_records_har() {
    let tmp = TempDir::new().unwrap();

    let backend = TestHttpBackend::start(Box::new(|_path| {
        Box::pin(async {
            (
                200u16,
                vec![("content-type".into(), "text/plain".into())],
                b"hello from backend".to_vec(),
            )
        })
    }))
    .await;

    // Watch the backend's address
    let watch_url = format!("http://localhost:{}/*", backend.addr.port());
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[&watch_url]).await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    // Plain HTTP through the proxy (no CONNECT, direct forwarding)
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}@{}", session_id, gw.proxy_addr)).unwrap())
        .build()
        .unwrap();

    let resp = client
        .get(format!("http://localhost:{}/data", backend.addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert_eq!(body, "hello from backend");

    // Poll until the exchange is recorded, then stop the session.
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);

    let entry = &entries[0];
    assert_eq!(entry["request"]["method"], "GET");
    assert_eq!(entry["response"]["status"], 200);
}

// -------------------------------------------------------------------------
// Test 4: Large response streaming (proves no full-body buffering)
// -------------------------------------------------------------------------

#[tokio::test]
async fn large_response_streams_without_timeout() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://localhost:*"]).await;

    // 1MB response
    let body_size: usize = 1024 * 1024;

    let backend = TestHttpsBackend::start(
        &gw.ca,
        Box::new(move |_path| {
            Box::pin(async move {
                let body = vec![b'X'; body_size];
                (
                    200u16,
                    vec![("content-type".into(), "application/octet-stream".into())],
                    body,
                )
            })
        }),
    )
    .await;

    let api_client = reqwest::Client::new();
    let session_id = create_session(&api_client, &gw).await;

    let client = proxy_client(gw.proxy_addr, &gw.ca.ca_cert_pem(), &session_id);
    let resp = client
        .get(format!("https://localhost:{}/large", backend.addr.port()))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body = resp.bytes().await.unwrap();
    assert_eq!(body.len(), body_size, "Should receive full 1MB response");

    // Poll until the exchange is recorded, then stop the session.
    let har = stop_and_get_har(&api_client, &gw, &session_id, 1).await;
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["response"]["status"], 200);

    // Large binary body should be base64-encoded in HAR
    let encoding = entries[0]["response"]["content"]["encoding"].as_str();
    assert_eq!(
        encoding,
        Some("base64"),
        "Large body should be base64 in HAR"
    );
}
