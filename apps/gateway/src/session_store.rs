// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Redis-backed session persistence for crash recovery.
//!
//! When a gateway pod dies and Kubernetes restarts it, the new pod has no
//! in-memory session state. `SessionStore` persists session records to Redis
//! so that the new pod can restore sessions on the first exchange from a
//! known client IP, allowing HAR recording to continue on the same blob.
//!
//! Two Redis keys are maintained per session:
//!   `gateway:session:{sessionId}` → full session record JSON
//!   `gateway:ip:{clientIp}`       → sessionId string
//!
//! Both keys are set with the same TTL derived from
//! `pluginSettings.other_plugin.max_session_duration_secs` (default: 3600s).
//! The TTL is set once at session start and never refreshed — it mirrors the
//! absolute max session duration enforced by the other_plugin plugin.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use backon::{ExponentialBuilder, Retryable};
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// The data persisted to Redis for each active session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub session_id: String,
    pub client_ip: IpAddr,
    pub plugin_settings: HashMap<String, serde_json::Value>,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

/// Redis-backed store for session persistence across pod restarts.
///
/// `SessionStore` is cheaply cloneable — `Client` is `Arc`-backed internally.
#[derive(Clone)]
pub struct SessionStore {
    client: Client,
}

impl SessionStore {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Persist a session to Redis with a TTL, retrying with exponential backoff.
    /// Both the session record and the IP→sessionId index are written.
    /// Logs a warning and gives up if all retries are exhausted.
    pub async fn save(&self, session: &PersistedSession, ttl: Duration) {
        let ttl_secs = ttl.as_secs() as i64;
        let session_key = format!("gateway:session:{}", session.session_id);
        let ip_key = format!("gateway:ip:{}", session.client_ip);

        let Ok(json) = serde_json::to_string(session) else {
            warn!(
                "SessionStore: failed to serialise session {}",
                session.session_id
            );
            return;
        };

        let retry = ExponentialBuilder::default()
            .with_min_delay(Duration::from_millis(200))
            .with_max_delay(Duration::from_secs(5))
            .with_max_times(10);

        let client = self.client.clone();
        let sk = session_key.clone();
        let jv = json.clone();
        let result = (|| async {
            client
                .set::<(), _, _>(
                    &sk,
                    jv.as_str(),
                    Some(Expiration::EX(ttl_secs)),
                    None,
                    false,
                )
                .await
                .map_err(anyhow::Error::from)
        })
        .retry(retry)
        .await;

        if let Err(e) = result {
            warn!(
                "SessionStore: failed to save session {} after retries: {}",
                session.session_id, e
            );
            return;
        }

        let client = self.client.clone();
        let ik = ip_key.clone();
        let sid = session.session_id.clone();
        let result = (|| async {
            client
                .set::<(), _, _>(
                    &ik,
                    sid.as_str(),
                    Some(Expiration::EX(ttl_secs)),
                    None,
                    false,
                )
                .await
                .map_err(anyhow::Error::from)
        })
        .retry(retry)
        .await;

        if let Err(e) = result {
            warn!(
                "SessionStore: failed to save IP index for {} after retries: {}",
                session.client_ip, e
            );
            return;
        }

        debug!(
            "SessionStore: saved session {} (ttl={}s)",
            session.session_id, ttl_secs
        );
    }

    /// Remove both Redis keys for a session (called on stop/clear).
    ///
    /// Keys are deleted individually rather than in a single multi-key DEL
    /// because Azure Redis Cluster hashes them to different slots (CROSSSLOT).
    pub async fn delete(&self, session_id: &str, client_ip: &IpAddr) {
        let session_key = format!("gateway:session:{}", session_id);
        let ip_key = format!("gateway:ip:{}", client_ip);

        if let Err(e) = self.client.del::<(), _>(&session_key).await {
            warn!(
                "SessionStore: failed to delete session key {}: {}",
                session_id, e
            );
        }
        if let Err(e) = self.client.del::<(), _>(&ip_key).await {
            warn!(
                "SessionStore: failed to delete IP key for {}: {}",
                client_ip, e
            );
        }
        debug!("SessionStore: deleted session {}", session_id);
    }

    /// Look up a session record by client IP.
    /// Returns `None` if no session exists for that IP.
    pub async fn get_by_ip(&self, client_ip: &IpAddr) -> Option<PersistedSession> {
        let ip_key = format!("gateway:ip:{}", client_ip);

        let session_id: Option<String> = match self.client.get(&ip_key).await {
            Ok(v) => v,
            Err(e) => {
                warn!("SessionStore: failed to lookup IP {}: {}", client_ip, e);
                return None;
            }
        };
        let session_id = session_id?;

        let session_key = format!("gateway:session:{}", session_id);
        let json: Option<String> = match self.client.get(&session_key).await {
            Ok(v) => v,
            Err(e) => {
                warn!("SessionStore: failed to get session {}: {}", session_id, e);
                return None;
            }
        };
        let json = json?;

        match serde_json::from_str::<PersistedSession>(&json) {
            Ok(s) => {
                debug!(
                    "SessionStore: restored session {} for IP {}",
                    session_id, client_ip
                );
                Some(s)
            }
            Err(e) => {
                warn!(
                    "SessionStore: failed to deserialise session {}: {}",
                    session_id, e
                );
                None
            }
        }
    }
}

/// Extract session TTL from plugin settings.
/// Uses `pluginSettings.other_plugin.max_session_duration_secs` when present.
/// Falls back to 3600s (1 hour) matching the other_plugin plugin default.
pub fn session_ttl(plugin_settings: &HashMap<String, serde_json::Value>) -> Duration {
    plugin_settings
        .get("other_plugin")
        .and_then(|v| v.get("max_session_duration_secs"))
        .and_then(|v| v.as_u64())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(3600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_ttl_default_when_no_settings() {
        let settings = HashMap::new();
        assert_eq!(session_ttl(&settings), Duration::from_secs(3600));
    }

    #[test]
    fn session_ttl_default_when_other_plugin_missing() {
        let mut settings = HashMap::new();
        settings.insert("other_plugin".to_string(), json!({"some": "value"}));
        assert_eq!(session_ttl(&settings), Duration::from_secs(3600));
    }

    #[test]
    fn session_ttl_default_when_field_missing_in_other_plugin() {
        let mut settings = HashMap::new();
        settings.insert("other_plugin".to_string(), json!({"other_field": 123}));
        assert_eq!(session_ttl(&settings), Duration::from_secs(3600));
    }

    #[test]
    fn session_ttl_reads_max_session_duration_secs() {
        let mut settings = HashMap::new();
        settings.insert(
            "other_plugin".to_string(),
            json!({"max_session_duration_secs": 7200}),
        );
        assert_eq!(session_ttl(&settings), Duration::from_secs(7200));
    }

    #[test]
    fn session_ttl_ignores_non_u64_value() {
        let mut settings = HashMap::new();
        settings.insert(
            "other_plugin".to_string(),
            json!({"max_session_duration_secs": "not_a_number"}),
        );
        assert_eq!(session_ttl(&settings), Duration::from_secs(3600));
    }
}
