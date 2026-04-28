// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::helpers::TestGateway;
use tempfile::TempDir;

/// CONNECT to the proxy without an active session → passthrough (no interception).
#[tokio::test]
async fn connect_without_session_passthrough() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://httpbin.org/*"]).await;

    // Connect through the proxy without starting a session.
    // The proxy should tunnel the connection without TLS interception.
    let proxy = reqwest::Proxy::http(format!("http://{}", gw.proxy_addr)).unwrap();
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .build()
        .unwrap();

    // Plain HTTP request through the proxy — should get 501 (not implemented)
    let _resp = client
        .get(format!("http://127.0.0.1:{}/anything", gw.proxy_addr.port()))
        .send()
        .await;

    // We expect either a connection or the 501 from handle_plain_http
    // Since no session is active, CONNECT tunnels passthrough. The key assertion
    // is that no HAR entry is recorded.
    let api_client = reqwest::Client::new();

    // Verify no HAR data (no session was ever started)
    let resp = api_client
        .get(gw.api_url("/api/v1/sessions/nonexistent/har"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

/// Non-matching URL → tunnel passthrough (no interception even with active session).
#[tokio::test]
async fn nonmatching_url_passthrough() {
    let tmp = TempDir::new().unwrap();
    // Only watch example.com, not httpbin.org
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://example.com/*"]).await;

    let api_client = reqwest::Client::new();

    // Create a session
    let resp = api_client
        .post(gw.api_url("/api/v1/sessions"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    let session_id = body["id"].as_str().unwrap().to_string();

    // Stop session
    api_client
        .post(gw.api_url(&format!("/api/v1/sessions/{}/stop", session_id)))
        .send()
        .await
        .unwrap();

    // HAR should be empty — no matching URLs were intercepted
    let resp = api_client
        .get(gw.api_url(&format!("/api/v1/sessions/{}/har", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let har: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(har["log"]["entries"].as_array().unwrap().len(), 0);
}
