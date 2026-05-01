// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Token Manager HTTP client.
//!
//! Acquires GitHub OAuth scopeless tokens from the Token Manager service
//! via its `POST /api/v1/keys/acquire` endpoint.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Response from the Token Manager `POST /api/v1/keys/acquire` endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireKeyResponse {
    pub value: String,
    pub key_id: String,
    pub key_type: String,
    pub capability: String,
}

/// Request body for the Token Manager `POST /api/v1/keys/acquire` endpoint.
#[derive(Debug, Serialize)]
pub struct AcquireKeyRequest {
    pub capability: String,
}

/// Acquires a GitHub OAuth scopeless token from the Token Manager.
pub async fn acquire_github_token(
    http_client: &reqwest::Client,
    token_manager_url: &str,
    capability: &str,
) -> Result<String> {
    let url = format!(
        "{}/api/v1/keys/acquire",
        token_manager_url.trim_end_matches('/')
    );

    let resp = http_client
        .post(&url)
        .json(&AcquireKeyRequest {
            capability: capability.to_string(),
        })
        .send()
        .await
        .context("Failed to reach Token Manager")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "Token Manager returned {} for capability '{}': {}",
            status,
            capability,
            body
        );
    }

    let key_resp: AcquireKeyResponse = resp
        .json()
        .await
        .context("Failed to parse Token Manager response")?;

    debug!(
        "Acquired {} token (key_id={}) for capability '{}'",
        key_resp.key_type, key_resp.key_id, key_resp.capability
    );

    Ok(key_resp.value)
}
