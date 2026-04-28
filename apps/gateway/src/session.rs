// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde_json::Value;

use crate::plugin::{PluginRegistry, SessionId};

/// State of a single session.
#[derive(Debug)]
pub struct Session {
    pub id: SessionId,
    pub active: bool,
    pub plugin_settings: HashMap<String, Value>,
    pub last_activity: Instant,
}

/// Manages source-IP-keyed sessions with idle reaping.
pub struct SessionManager {
    sessions: RwLock<HashMap<SessionId, Session>>,
    registry: Arc<PluginRegistry>,
    idle_timeout: Duration,
    max_sessions: usize,
}

impl SessionManager {
    pub fn new(registry: Arc<PluginRegistry>, idle_timeout: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
        }
    }

    /// Start a session for the given ID. Clears any previous session first.
    pub fn start_session(
        &self,
        session_id: SessionId,
        plugin_settings: HashMap<String, Value>,
    ) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();

        // If session already exists, clear it first
        if sessions.contains_key(&session_id) {
            self.registry.on_session_clear(&session_id);
        }

        // Check capacity (after potential removal of existing)
        if !sessions.contains_key(&session_id) && sessions.len() >= self.max_sessions {
            return Err(SessionError::MaxSessionsReached);
        }

        self.registry.on_session_start(&session_id, &plugin_settings);

        sessions.insert(
            session_id.clone(),
            Session {
                id: session_id,
                active: true,
                plugin_settings,
                last_activity: Instant::now(),
            },
        );

        Ok(())
    }

    /// Stop a session. Notifies plugins to finalize.
    pub fn stop_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        let mut sessions = self.sessions.write();
        let session = sessions
            .get_mut(session_id)
            .ok_or(SessionError::NotFound)?;

        if !session.active {
            return Err(SessionError::NotActive);
        }

        session.active = false;
        self.registry.on_session_stop(session_id);
        Ok(())
    }

    /// Check if a session is active (for proxy handler to decide intercept vs passthrough).
    pub fn is_active(&self, session_id: &SessionId) -> bool {
        let sessions = self.sessions.read();
        sessions
            .get(session_id)
            .map(|s| s.active)
            .unwrap_or(false)
    }

    /// Touch a session to reset its idle timer.
    pub fn touch(&self, session_id: &SessionId) {
        let mut sessions = self.sessions.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
        }
    }

    /// Get session status (exists, active).
    pub fn get_status(&self, session_id: &SessionId) -> Option<bool> {
        let sessions = self.sessions.read();
        sessions.get(session_id).map(|s| s.active)
    }

    /// Reap idle sessions. Called periodically.
    pub fn reap_idle(&self) -> Vec<SessionId> {
        let mut sessions = self.sessions.write();
        let now = Instant::now();
        let mut reaped = Vec::new();

        sessions.retain(|id, session| {
            if now.duration_since(session.last_activity) > self.idle_timeout {
                self.registry.on_session_clear(id);
                reaped.push(id.clone());
                false
            } else {
                true
            }
        });

        reaped
    }

    /// Number of active sessions.
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

    fn make_manager(max: usize) -> SessionManager {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        SessionManager::new(registry, Duration::from_secs(300), max)
    }

    #[test]
    fn start_and_stop_session() {
        let mgr = make_manager(100);
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        assert!(mgr.is_active(&"10.0.0.1".into()));

        mgr.stop_session(&"10.0.0.1".into()).unwrap();
        assert!(!mgr.is_active(&"10.0.0.1".into()));
    }

    #[test]
    fn stop_nonexistent_returns_error() {
        let mgr = make_manager(100);
        assert!(matches!(
            mgr.stop_session(&"10.0.0.1".into()),
            Err(SessionError::NotFound)
        ));
    }

    #[test]
    fn stop_already_stopped_returns_error() {
        let mgr = make_manager(100);
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        mgr.stop_session(&"10.0.0.1".into()).unwrap();
        assert!(matches!(
            mgr.stop_session(&"10.0.0.1".into()),
            Err(SessionError::NotActive)
        ));
    }

    #[test]
    fn max_sessions_enforced() {
        let mgr = make_manager(2);
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        mgr.start_session("10.0.0.2".into(), HashMap::new())
            .unwrap();
        assert!(matches!(
            mgr.start_session("10.0.0.3".into(), HashMap::new()),
            Err(SessionError::MaxSessionsReached)
        ));
    }

    #[test]
    fn restart_existing_session_does_not_count_as_new() {
        let mgr = make_manager(1);
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        // Restarting same session should succeed even at max capacity
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        assert!(mgr.is_active(&"10.0.0.1".into()));
    }

    #[test]
    fn no_session_means_not_active() {
        let mgr = make_manager(100);
        assert!(!mgr.is_active(&"10.0.0.1".into()));
    }

    #[test]
    fn get_status_returns_none_for_unknown() {
        let mgr = make_manager(100);
        assert!(mgr.get_status(&"10.0.0.1".into()).is_none());
    }

    #[test]
    fn idle_reaping() {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new(registry, Duration::from_millis(0), 100);
        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();

        // With 0ms timeout, everything should be reaped immediately
        let reaped = mgr.reap_idle();
        assert_eq!(reaped.len(), 1);
        assert_eq!(mgr.session_count(), 0);
    }

    #[test]
    fn session_count_tracks_correctly() {
        let mgr = make_manager(100);
        assert_eq!(mgr.session_count(), 0);

        mgr.start_session("10.0.0.1".into(), HashMap::new())
            .unwrap();
        assert_eq!(mgr.session_count(), 1);

        mgr.start_session("10.0.0.2".into(), HashMap::new())
            .unwrap();
        assert_eq!(mgr.session_count(), 2);
    }
}
