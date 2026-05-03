// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Session lifecycle manager with UUID-keyed sessions.
//!
//! Workers identify themselves via Proxy-Authorization headers (session ID
//! embedded in the proxy URL userinfo). Sessions have an idle timeout enforced
//! by a background reaper task.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

// parking_lot::RwLock over std::sync::RwLock: no poisoning overhead, better
// performance for read-heavy workloads (proxy lookups are reads; mutations are rare).
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;

use crate::plugin::{PluginRegistry, SessionId};
use crate::session_store::{session_ttl, PersistedSession, SessionPersistence};

/// State of a single session.
#[derive(Debug)]
pub struct Session {
    pub id: SessionId,
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

/// Manages UUID-keyed sessions.
pub struct SessionManager {
    sessions_lock: RwLock<HashMap<SessionId, Session>>,
    registry: Arc<PluginRegistry>,
    idle_timeout: Duration,
    max_sessions: usize,
    /// Optional persistence backend (Redis in production, mock in tests).
    store: Option<Box<dyn SessionPersistence>>,
}

impl SessionManager {
    /// Create a new session manager without Redis persistence.
    pub fn new(registry: Arc<PluginRegistry>, idle_timeout: Duration, max_sessions: usize) -> Self {
        Self {
            sessions_lock: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
            store: None,
        }
    }

    /// Create a session manager with a persistence backend.
    pub fn new_with_store(
        registry: Arc<PluginRegistry>,
        idle_timeout: Duration,
        max_sessions: usize,
        store: impl SessionPersistence + 'static,
    ) -> Self {
        Self {
            sessions_lock: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
            store: Some(Box::new(store)),
        }
    }

    /// Create and start a session with the given client-provided ID.
    ///
    /// If a session with that ID already exists and is active, returns
    /// `Ok(false)` (idempotent). Returns `Ok(true)` when newly created.
    pub async fn create_session(
        &self,
        session_id: SessionId,
        plugin_settings: HashMap<String, Value>,
    ) -> Result<bool, SessionError> {
        // If session already exists and is active, return idempotent success.
        {
            let sessions = self.sessions_lock.read();
            if let Some(session) = sessions.get(&session_id) {
                if session.active {
                    return Ok(false);
                }
            }
            if sessions.len() >= self.max_sessions {
                return Err(SessionError::MaxSessionsReached);
            }
        }

        // Notify plugins before inserting — they set up per-session state.
        self.registry
            .on_session_start(&session_id, &plugin_settings)
            .await;

        // Insert into map.
        {
            let mut sessions = self.sessions_lock.write();
            sessions.insert(
                session_id.clone(),
                Session {
                    id: session_id.clone(),
                    active: true,
                    plugin_settings: plugin_settings.clone(),
                    started_at: chrono::Utc::now(),
                    last_activity: Instant::now(),
                },
            );
        }

        // Persist to Redis (SET NX) — returns false if session already exists
        // on another replica. This is the cross-replica idempotency check.
        let is_new = if let Some(store) = &self.store {
            let persisted = PersistedSession {
                session_id: session_id.clone(),
                plugin_settings: plugin_settings.clone(),
                started_at: chrono::Utc::now(),
            };
            let ttl = session_ttl(&plugin_settings);
            store.save(&persisted, ttl).await
        } else {
            true
        };

        Ok(is_new)
    }

    /// Stop a session. Notifies plugins to finalize.
    pub async fn stop_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        // Validate and mark inactive under lock, then drop lock before awaiting.
        {
            let mut sessions = self.sessions_lock.write();
            let session = sessions.get_mut(session_id).ok_or(SessionError::NotFound)?;
            if !session.active {
                return Err(SessionError::NotActive);
            }
            session.active = false;
        }
        self.registry.on_session_stop(session_id).await;

        // Delete from Redis on explicit stop.
        if let Some(store) = &self.store {
            store.delete(session_id).await;
        }

        Ok(())
    }

    /// Delete a session entirely — clears plugin data and removes from the map.
    pub async fn delete_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        {
            let mut sessions = self.sessions_lock.write();
            sessions.remove(session_id).ok_or(SessionError::NotFound)?;
        }
        self.registry.on_session_clear(session_id).await;

        // Delete from Redis on explicit clear.
        if let Some(store) = &self.store {
            store.delete(session_id).await;
        }

        Ok(())
    }

    /// Check if a session is active (for proxy handler to decide intercept vs passthrough).
    pub fn is_active(&self, session_id: &SessionId) -> bool {
        let sessions = self.sessions_lock.read();
        sessions.get(session_id).map(|s| s.active).unwrap_or(false)
    }

    /// Touch a session to reset its idle timer.
    pub fn touch(&self, session_id: &SessionId) {
        let mut sessions = self.sessions_lock.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
        }
    }

    /// Get session info by ID.
    pub fn get_session(&self, session_id: &SessionId) -> Option<SessionInfo> {
        let sessions = self.sessions_lock.read();
        sessions.get(session_id).map(SessionInfo::from)
    }

    /// List all sessions.
    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions_lock.read();
        sessions.values().map(SessionInfo::from).collect()
    }

    /// Reap idle sessions. Called periodically.
    pub async fn reap_idle(&self) -> Vec<SessionId> {
        let reaped: Vec<SessionId> = {
            let mut sessions = self.sessions_lock.write();
            let now = Instant::now();
            let mut reaped = Vec::new();
            sessions.retain(|id, session| {
                if now.duration_since(session.last_activity) > self.idle_timeout {
                    reaped.push(id.clone());
                    false
                } else {
                    true
                }
            });
            reaped
        };
        for id in &reaped {
            self.registry.on_session_clear(id).await;
        }
        reaped
    }

    /// Number of sessions.
    pub fn session_count(&self) -> usize {
        self.sessions_lock.read().len()
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
    use crate::session_store::SessionPersistence;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn make_manager(max: usize) -> SessionManager {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        SessionManager::new(registry, Duration::from_secs(300), max)
    }

    /// In-memory mock that records calls and returns configurable results.
    struct MockStore {
        /// Controls what `save()` returns: `true` = new, `false` = already exists.
        save_returns_new: bool,
        save_calls: Arc<AtomicUsize>,
        delete_calls: Arc<AtomicUsize>,
    }

    impl MockStore {
        fn new(save_returns_new: bool) -> (Self, Arc<AtomicUsize>, Arc<AtomicUsize>) {
            let save_calls = Arc::new(AtomicUsize::new(0));
            let delete_calls = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    save_returns_new,
                    save_calls: save_calls.clone(),
                    delete_calls: delete_calls.clone(),
                },
                save_calls,
                delete_calls,
            )
        }
    }

    #[async_trait]
    impl SessionPersistence for MockStore {
        async fn save(&self, _session: &PersistedSession, _ttl: Duration) -> bool {
            self.save_calls.fetch_add(1, Ordering::Relaxed);
            self.save_returns_new
        }
        async fn delete(&self, _session_id: &str) {
            self.delete_calls.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[tokio::test]
    async fn create_and_stop_session() {
        let mgr = make_manager(100);
        let created = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(created);
        assert!(mgr.is_active(&"s1".into()));

        mgr.stop_session(&"s1".into()).await.unwrap();
        assert!(!mgr.is_active(&"s1".into()));
    }

    #[tokio::test]
    async fn create_same_id_is_idempotent() {
        let mgr = make_manager(100);
        let first = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(first); // newly created

        let second = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(!second); // already existed
        assert_eq!(mgr.session_count(), 1);
    }

    #[tokio::test]
    async fn stop_nonexistent_returns_error() {
        let mgr = make_manager(100);
        assert!(matches!(
            mgr.stop_session(&"nonexistent".into()).await,
            Err(SessionError::NotFound)
        ));
    }

    #[tokio::test]
    async fn stop_already_stopped_returns_error() {
        let mgr = make_manager(100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.stop_session(&"s1".into()).await.unwrap();
        assert!(matches!(
            mgr.stop_session(&"s1".into()).await,
            Err(SessionError::NotActive)
        ));
    }

    #[tokio::test]
    async fn max_sessions_enforced() {
        let mgr = make_manager(2);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.create_session("s2".into(), HashMap::new())
            .await
            .unwrap();
        assert!(matches!(
            mgr.create_session("s3".into(), HashMap::new()).await,
            Err(SessionError::MaxSessionsReached)
        ));
    }

    #[tokio::test]
    async fn idempotent_create_does_not_count_against_max() {
        let mgr = make_manager(1);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        // Retry same ID — should succeed even though max=1
        let second = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(!second);
    }

    #[tokio::test]
    async fn delete_session_removes_entirely() {
        let mgr = make_manager(100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.delete_session(&"s1".into()).await.unwrap();
        assert_eq!(mgr.session_count(), 0);
        assert!(mgr.get_session(&"s1".into()).is_none());
    }

    #[tokio::test]
    async fn delete_nonexistent_returns_error() {
        let mgr = make_manager(100);
        assert!(matches!(
            mgr.delete_session(&"nonexistent".into()).await,
            Err(SessionError::NotFound)
        ));
    }

    #[tokio::test]
    async fn list_sessions_returns_all() {
        let mgr = make_manager(100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.create_session("s2".into(), HashMap::new())
            .await
            .unwrap();
        assert_eq!(mgr.list_sessions().len(), 2);
    }

    #[tokio::test]
    async fn get_session_returns_info() {
        let mgr = make_manager(100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        let info = mgr.get_session(&"s1".into()).unwrap();
        assert_eq!(info.id, "s1");
        assert!(info.active);
    }

    #[test]
    fn no_session_means_not_active() {
        let mgr = make_manager(100);
        assert!(!mgr.is_active(&"nonexistent".into()));
    }

    #[tokio::test]
    async fn idle_reaping() {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new(registry, Duration::from_millis(0), 100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        let reaped = mgr.reap_idle().await;
        assert_eq!(reaped.len(), 1);
        assert_eq!(mgr.session_count(), 0);
    }

    #[tokio::test]
    async fn session_count_tracks_correctly() {
        let mgr = make_manager(100);
        assert_eq!(mgr.session_count(), 0);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert_eq!(mgr.session_count(), 1);

        mgr.create_session("s2".into(), HashMap::new())
            .await
            .unwrap();
        assert_eq!(mgr.session_count(), 2);
    }

    // --- Tests with MockStore ---

    #[tokio::test]
    async fn create_session_calls_store_save() {
        let (mock, save_calls, _delete_calls) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        let result = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(result); // store returned true → new
        assert_eq!(save_calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn create_session_returns_false_when_store_says_existing() {
        let (mock, save_calls, _) = MockStore::new(false); // store says "already exists"
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        let result = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(!result); // cross-replica idempotent
        assert_eq!(save_calls.load(Ordering::Relaxed), 1);
        // Session should still be in-memory even though Redis had it
        assert!(mgr.is_active(&"s1".into()));
    }

    #[tokio::test]
    async fn idempotent_create_skips_store_on_second_call() {
        let (mock, save_calls, _) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        // Second call with same ID — early return from in-memory check
        let second = mgr
            .create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        assert!(!second);
        // Store should only have been called once (first create)
        assert_eq!(save_calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn stop_session_calls_store_delete() {
        let (mock, _, delete_calls) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.stop_session(&"s1".into()).await.unwrap();
        assert_eq!(delete_calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn delete_session_calls_store_delete() {
        let (mock, _, delete_calls) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();
        mgr.delete_session(&"s1".into()).await.unwrap();
        assert_eq!(delete_calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn stop_nonexistent_does_not_call_store_delete() {
        let (mock, _, delete_calls) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        let _ = mgr.stop_session(&"nonexistent".into()).await;
        assert_eq!(delete_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn create_session_with_store_uses_custom_ttl() {
        // Verify save is called (TTL correctness is a store concern, but we
        // confirm the path through session_ttl → store.save is exercised).
        let (mock, save_calls, _) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(registry, Duration::from_secs(300), 100, mock);

        let mut settings = HashMap::new();
        settings.insert(
            "plugin".to_string(),
            serde_json::json!({"max_session_duration_secs": 7200}),
        );
        let result = mgr.create_session("s1".into(), settings).await.unwrap();
        assert!(result);
        assert_eq!(save_calls.load(Ordering::Relaxed), 1);
    }
}
