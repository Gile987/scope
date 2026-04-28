// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::helpers::TestGateway;
use tempfile::TempDir;

/// POST /session/start → POST /session/stop → GET /proxy/har lifecycle.
#[tokio::test]
async fn session_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://example.com/*"]).await;

    let client = reqwest::Client::new();

    // GET /proxy — no active session
    let resp = client.get(gw.api_url("/proxy")).send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // POST /session/start
    let resp = client
        .post(gw.api_url("/session/start"))
        .json(&serde_json::json!({"plugins": {"har": {"includeSensitiveInformation": false}}}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // GET /proxy — session active
    let resp = client.get(gw.api_url("/proxy")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["active"], true);

    // POST /session/stop
    let resp = client
        .post(gw.api_url("/session/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // GET /proxy/har — should return empty HAR (no traffic intercepted)
    let resp = client.get(gw.api_url("/proxy/har")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let har: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(har["log"]["version"], "1.2");
    assert_eq!(har["log"]["entries"].as_array().unwrap().len(), 0);
}

/// GET /proxy/rootCertificate returns valid PEM.
#[tokio::test]
async fn root_certificate_endpoint() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(gw.api_url("/proxy/rootCertificate"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let pem = resp.text().await.unwrap();
    assert!(pem.contains("BEGIN CERTIFICATE"));
    assert!(pem.contains("END CERTIFICATE"));
}

/// GET /proxy/har returns 404 when no session exists.
#[tokio::test]
async fn har_returns_404_without_session() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client.get(gw.api_url("/proxy/har")).send().await.unwrap();
    assert_eq!(resp.status(), 404);
}

/// GET /proxy/har returns empty HAR when session is active (no exchanges yet).
#[tokio::test]
async fn har_returns_empty_har_while_session_active() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();

    // Start session but don't stop
    client
        .post(gw.api_url("/session/start"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();

    let resp = client.get(gw.api_url("/proxy/har")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["log"]["entries"].as_array().unwrap().len(), 0);
}

/// POST /session/stop without start returns error.
#[tokio::test]
async fn stop_without_start_returns_error() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(gw.api_url("/session/stop"))
        .send()
        .await
        .unwrap();
    // Should return a non-200 status
    assert_ne!(resp.status(), 200);
}
