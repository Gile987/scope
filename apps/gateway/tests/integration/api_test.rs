// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use super::helpers::TestGateway;
use tempfile::TempDir;

/// POST /api/v1/sessions → POST .../stop → GET .../har lifecycle.
#[tokio::test]
async fn session_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &["https://example.com/*"]).await;

    let client = reqwest::Client::new();

    // GET /health
    let resp = client.get(gw.api_url("/health")).send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // POST /api/v1/sessions — create session
    let session_id = uuid::Uuid::new_v4().to_string();
    let resp = client
        .post(gw.api_url("/api/v1/sessions"))
        .json(
            &serde_json::json!({"id": session_id, "plugins": {"har": {"redactCredentials": true}}}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["id"].as_str().unwrap(), session_id);

    // GET /api/v1/sessions/:id — session status
    let resp = client
        .get(gw.api_url(&format!("/api/v1/sessions/{}", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["active"], true);
    assert_eq!(body["id"], session_id);

    // GET /api/v1/sessions — list sessions
    let resp = client
        .get(gw.api_url("/api/v1/sessions"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body.as_array().unwrap().len(), 1);

    // POST /api/v1/sessions/:id/stop
    let resp = client
        .post(gw.api_url(&format!("/api/v1/sessions/{}/stop", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // GET /api/v1/sessions/:id/har — should return empty HAR (no traffic intercepted)
    let resp = client
        .get(gw.api_url(&format!("/api/v1/sessions/{}/har", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let har: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(har["log"]["version"], "1.2");
    assert_eq!(har["log"]["entries"].as_array().unwrap().len(), 0);

    // DELETE /api/v1/sessions/:id
    let resp = client
        .delete(gw.api_url(&format!("/api/v1/sessions/{}", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // Verify session is gone
    let resp = client
        .get(gw.api_url(&format!("/api/v1/sessions/{}", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

/// GET /api/v1/cacert returns valid PEM.
#[tokio::test]
async fn cacert_endpoint() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(gw.api_url("/api/v1/cacert"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let pem = resp.text().await.unwrap();
    assert!(pem.contains("BEGIN CERTIFICATE"));
    assert!(pem.contains("END CERTIFICATE"));
}

/// GET /api/v1/sessions/:id/har returns 404 when no session exists.
#[tokio::test]
async fn har_returns_404_without_session() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(gw.api_url("/api/v1/sessions/nonexistent/har"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

/// GET /api/v1/sessions/:id/har returns empty HAR when session is active (no exchanges yet).
#[tokio::test]
async fn har_returns_empty_har_while_session_active() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();

    // Create session
    let session_id = uuid::Uuid::new_v4().to_string();
    let resp = client
        .post(gw.api_url("/api/v1/sessions"))
        .json(&serde_json::json!({"id": session_id}))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["id"].as_str().unwrap(), session_id);

    let resp = client
        .get(gw.api_url(&format!("/api/v1/sessions/{}/har", session_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["log"]["entries"].as_array().unwrap().len(), 0);
}

/// POST /api/v1/sessions/:id/stop without a valid session returns 404.
#[tokio::test]
async fn stop_without_start_returns_error() {
    let tmp = TempDir::new().unwrap();
    let gw = TestGateway::start(tmp.path().to_path_buf(), &[]).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(gw.api_url("/api/v1/sessions/nonexistent/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}
