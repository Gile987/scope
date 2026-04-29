// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Session lifecycle manager with UUID-keyed sessions and an IP→session reverse index.
//!
//! The proxy layer resolves client IPs to session IDs on every request, so each
//! coding-agent container automatically gets its own recording session without
//! client-side session tracking. Sessions have an idle timeout enforced by a
//! background reaper task.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

// parking_lot::RwLock over std::sync::RwLock: no poisoning overhead, better
// performance for read-heavy workloads (proxy lookups are reads; mutations are rare).
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::plugin::{PluginRegistry, SessionId};

/// State of a single session.
#[derive(Debug)]
pub struct Session {
    pub id: SessionId,
    pub client_ip: IpAddr,
    pub active: bool,
    pub plugin_settings: HashMap<String, Value>,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub last_activity: Instant,
}

/// Summary returned by list / get endpoints.
#[derive(Debug, Serialize, Clone)]
pub struct SessionInfo {
    pub id: SessionId,
    pub active: bool,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

impl From<&Session> for SessionInfo {
    fn from(s: &Session) -> Self {
        Self {
            id: s.id.clone(),
            active: s.active,
            started_at: s
                .started_at
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// Manages UUID-keyed sessions with an IP→session reverse index for the proxy layer.
pub struct SessionManager {
    sessions: RwLock<HashMap<SessionId, Session>>,
    ip_index: RwLock<HashMap<IpAddr, SessionId>>,
    registry: Arc<PluginRegistry>,
    idle_timeout: Duration,
    max_sessions: usize,
}

impl SessionManager {
    /// Create a new session manager.
    ///
    /// * `registry` — plugin registry to notify on lifecycle events
    /// * `idle_timeout` — how long before an inactive session is reaped
    /// * `max_sessions` — upper bound on concurrent sessions
    pub fn new(registry: Arc<PluginRegistry>, idle_timeout: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            ip_index: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
        }
    }

    /// Create and start a session for the given client IP. Returns the new session ID.
    pub fn create_session(
        &self,
        client_ip: IpAddr,
        plugin_settings: HashMap<String, Value>,
    ) -> Result<SessionId, SessionError> {
        let mut sessions = self.sessions.write();
        let mut ip_index = self.ip_index.write();

        // If this IP already has an active session, tear it down first.
        // This handles agent container restarts — the new session replaces the
        // stale one without hitting the max_sessions cap.
        if let Some(old_id) = ip_index.get(&client_ip) {
            let old_id = old_id.clone();
            self.registry.on_session_clear(&old_id);
            sessions.remove(&old_id);
            ip_index.remove(&client_ip);
        }

        // Check capacity
        if sessions.len() >= self.max_sessions {
            return Err(SessionError::MaxSessionsReached);
        }

        let session_id = Uuid::new_v4().to_string();

        self.registry
            .on_session_start(&session_id, &plugin_settings);

        sessions.insert(
            session_id.clone(),
            Session {
                id: session_id.clone(),
                client_ip,
                active: true,
                plugin_settings,
                started_at: chrono::Utc::now(),
                last_activity: Instant::now(),
            },
        );
        ip_index.insert(client_ip, session_id.clone());

        Ok(session_id)
    }

    /// Stop a session. Notifies plugins to finalize.
    pub fn stop_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();
        let session = sessions.get_mut(session_id).ok_or(SessionError::NotFound)?;

        if !session.active {
            return Err(SessionError::NotActive);
        }

        session.active = false;
        self.registry.on_session_stop(session_id);
        Ok(())
    }

    /// Delete a session entirely — clears plugin data and removes from both maps.
    pub fn delete_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();
        let mut ip_index = self.ip_index.write();

        let session = sessions.remove(session_id).ok_or(SessionError::NotFound)?;
        ip_index.remove(&session.client_ip);
        self.registry.on_session_clear(session_id);
        Ok(())
    }

    /// Look up the active session ID for a client IP (used by proxy handler).
    pub fn session_id_for_ip(&self, ip: &IpAddr) -> Option<SessionId> {
        let ip_index = self.ip_index.read();
        let session_id = ip_index.get(ip)?;
        let sessions = self.sessions.read();
        let session = sessions.get(session_id)?;
        if session.active {
            Some(session_id.clone())
        } else {
            None
        }
    }

    /// Check if a session is active (for proxy handler to decide intercept vs passthrough).
    pub fn is_active(&self, session_id: &SessionId) -> bool {
        let sessions = self.sessions.read();
        sessions.get(session_id).map(|s| s.active).unwrap_or(false)
    }

    /// Touch a session to reset its idle timer.
    pub fn touch(&self, session_id: &SessionId) {
        let mut sessions = self.sessions.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
        }
    }

    /// Get session info by ID.
    pub fn get_session(&self, session_id: &SessionId) -> Option<SessionInfo> {
        let sessions = self.sessions.read();
        sessions.get(session_id).map(SessionInfo::from)
    }

    /// List all sessions.
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read();
        sessions.values().map(SessionInfo::from).collect()
    }

    /// Reap idle sessions. Called periodically.
    pub fn reap_idle(&self) -> Vec<SessionId> {
        let mut sessions = self.sessions.write();
        let mut ip_index = self.ip_index.write();
        let now = Instant::now();
        let mut reaped = Vec::new();

        sessions.retain(|id, session| {
            if now.duration_since(session.last_activity) > self.idle_timeout {
                self.registry.on_session_clear(id);
                ip_index.remove(&session.client_ip);
                reaped.push(id.clone());
                false
            } else {
                true
            }
        });

        reaped
    }

    /// Number of sessions.
    pub fn session_count(&self) -> usize {
        self.sessions.read().len()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session not found")]
    NotFound,
    #[error("session is not active")]
    NotActive,
    #[error("max concurrent sessions reached")]
    MaxSessionsReached,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::PluginRegistry;
    use std::net::{IpAddr, Ipv4Addr};

    const IP1: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
    const IP2: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2));
    const IP3: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 3));

    fn make_manager(max: usize) -> SessionManager {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        SessionManager::new(registry, Duration::from_secs(300), max)
    }

    #[test]
    fn create_and_stop_session() {
        let mgr = make_manager(100);
        let id = mgr.create_session(IP1, HashMap::new()).unwrap();
        assert!(mgr.is_active(&id));

        mgr.stop_session(&id).unwrap();
        assert!(!mgr.is_active(&id));
    }

    #[test]
    fn stop_nonexistent_returns_error() {
        let mgr = make_manager(100);
        assert!(matches!(
            mgr.stop_session(&"nonexistent".into()),
            Err(SessionError::NotFound)
        ));
    }

    #[test]
    fn stop_already_stopped_returns_error() {
        let mgr = make_manager(100);
        let id = mgr.create_session(IP1, HashMap::new()).unwrap();
        mgr.stop_session(&id).unwrap();
        assert!(matches!(
            mgr.stop_session(&id),
            Err(SessionError::NotActive)
        ));
    }

    #[test]
    fn max_sessions_enforced() {
        let mgr = make_manager(2);
        mgr.create_session(IP1, HashMap::new()).unwrap();
        mgr.create_session(IP2, HashMap::new()).unwrap();
        assert!(matches!(
            mgr.create_session(IP3, HashMap::new()),
            Err(SessionError::MaxSessionsReached)
        ));
    }

    #[test]
    fn restart_same_ip_replaces_session() {
        let mgr = make_manager(1);
        let id1 = mgr.create_session(IP1, HashMap::new()).unwrap();
        // Same IP — should replace, not exceed max
        let id2 = mgr.create_session(IP1, HashMap::new()).unwrap();
        assert_ne!(id1, id2);
        assert!(!mgr.is_active(&id1)); // old session gone
        assert!(mgr.is_active(&id2));
        assert_eq!(mgr.session_count(), 1);
    }

    #[test]
    fn session_id_for_ip_returns_active_only() {
        let mgr = make_manager(100);
        let id = mgr.create_session(IP1, HashMap::new()).unwrap();
        assert_eq!(mgr.session_id_for_ip(&IP1), Some(id.clone()));

        mgr.stop_session(&id).unwrap();
        assert_eq!(mgr.session_id_for_ip(&IP1), None);
    }

    #[test]
    fn delete_session_removes_entirely() {
        let mgr = make_manager(100);
        let id = mgr.create_session(IP1, HashMap::new()).unwrap();
        mgr.delete_session(&id).unwrap();
        assert_eq!(mgr.session_count(), 0);
        assert_eq!(mgr.session_id_for_ip(&IP1), None);
        assert!(mgr.get_session(&id).is_none());
    }

    #[test]
    fn delete_nonexistent_returns_error() {
        let mgr = make_manager(100);
        assert!(matches!(
            mgr.delete_session(&"nonexistent".into()),
            Err(SessionError::NotFound)
        ));
    }

    #[test]
    fn list_sessions_returns_all() {
        let mgr = make_manager(100);
        mgr.create_session(IP1, HashMap::new()).unwrap();
        mgr.create_session(IP2, HashMap::new()).unwrap();
        assert_eq!(mgr.list_sessions().len(), 2);
    }

    #[test]
    fn get_session_returns_info() {
        let mgr = make_manager(100);
        let id = mgr.create_session(IP1, HashMap::new()).unwrap();
        let info = mgr.get_session(&id).unwrap();
        assert_eq!(info.id, id);
        assert!(info.active);
    }

    #[test]
    fn no_session_means_not_active() {
        let mgr = make_manager(100);
        assert!(!mgr.is_active(&"nonexistent".into()));
    }

    #[test]
    fn idle_reaping() {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new(registry, Duration::from_millis(0), 100);
        mgr.create_session(IP1, HashMap::new()).unwrap();

        // With 0ms timeout, everything should be reaped immediately
        let reaped = mgr.reap_idle();
        assert_eq!(reaped.len(), 1);
        assert_eq!(mgr.session_count(), 0);
        assert_eq!(mgr.session_id_for_ip(&IP1), None);
    }

    #[test]
    fn session_count_tracks_correctly() {
        let mgr = make_manager(100);
        assert_eq!(mgr.session_count(), 0);

        mgr.create_session(IP1, HashMap::new()).unwrap();
        assert_eq!(mgr.session_count(), 1);

        mgr.create_session(IP2, HashMap::new()).unwrap();
        assert_eq!(mgr.session_count(), 2);
    }
}
