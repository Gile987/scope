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
use tokio::sync::watch;
use tracing::{debug, info, warn};

use crate::iteration_store::IterationStore;
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
    /// Number of proxy requests currently in flight for this session.
    /// The reaper skips sessions with `in_flight > 0` so a long-running
    /// streaming response cannot be deleted out from under the request.
    pub in_flight: u32,
    /// Cancellation signal for long-lived in-flight relays (notably persistent
    /// WebSocket connections, e.g. Codex's Responses-over-WebSocket). Set to
    /// `true` on explicit stop so the relay loop breaks and flushes its
    /// accumulated `_webSocketMessages` HAR entry before the session finalizes.
    pub cancel_tx: watch::Sender<bool>,
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
    /// Iteration counter store — always present.
    iteration_store: Arc<dyn IterationStore>,
}

impl SessionManager {
    /// Create a new session manager without Redis persistence.
    pub fn new(
        registry: Arc<PluginRegistry>,
        idle_timeout: Duration,
        max_sessions: usize,
        iteration_store: Arc<dyn IterationStore>,
    ) -> Self {
        Self {
            sessions_lock: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
            store: None,
            iteration_store,
        }
    }

    /// Create a session manager with a persistence backend.
    pub fn new_with_store(
        registry: Arc<PluginRegistry>,
        idle_timeout: Duration,
        max_sessions: usize,
        store: impl SessionPersistence + 'static,
        iteration_store: Arc<dyn IterationStore>,
    ) -> Self {
        Self {
            sessions_lock: RwLock::new(HashMap::new()),
            registry,
            idle_timeout,
            max_sessions,
            store: Some(Box::new(store)),
            iteration_store,
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
                    in_flight: 0,
                    cancel_tx: watch::channel(false).0,
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

        // Initialise the iteration counter.
        let ttl_secs = session_ttl(&plugin_settings).as_secs() as i64;
        self.iteration_store.init(&session_id, ttl_secs).await;

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
            // Signal long-lived relays (persistent WebSocket connections) to
            // break and flush their HAR entry. Workers stop the session as soon
            // as a turn completes, while an agent like Codex keeps its
            // Responses-over-WebSocket connection open — without this the
            // buffered frames would never be recorded.
            let _ = session.cancel_tx.send(true);
        }

        // Wait for in-flight relays to flush (e.g. a cancelled WebSocket relay
        // appends its `_webSocketMessages` entry, then drops its in-flight
        // guard) before finalizing the HAR, so the captured frames are present
        // when the worker immediately reads the HAR after stop returns.
        self.drain_in_flight(session_id, Duration::from_secs(5))
            .await;

        self.registry.on_session_stop(session_id).await;

        // Delete from Redis on explicit stop.
        if let Some(store) = &self.store {
            store.delete(session_id).await;
        }

        Ok(())
    }

    /// Subscribe to a session's cancellation signal. Returns `None` if the
    /// session no longer exists. Used by long-lived relays (WebSocket) to break
    /// their loop when the session is explicitly stopped.
    pub fn subscribe_cancel(&self, session_id: &SessionId) -> Option<watch::Receiver<bool>> {
        self.sessions_lock
            .read()
            .get(session_id)
            .map(|s| s.cancel_tx.subscribe())
    }

    /// Poll until a session has no in-flight requests or the timeout elapses.
    /// Used on stop to give cancelled WebSocket relays a chance to flush their
    /// HAR entry before the session is finalized.
    async fn drain_in_flight(&self, session_id: &SessionId, timeout: Duration) {
        let start = Instant::now();
        loop {
            let n = self
                .sessions_lock
                .read()
                .get(session_id)
                .map(|s| s.in_flight)
                .unwrap_or(0);
            if n == 0 {
                return;
            }
            if start.elapsed() >= timeout {
                warn!(
                    session_id = %session_id,
                    in_flight = n,
                    timeout_secs = timeout.as_secs(),
                    "drain_in_flight: timed out waiting for in-flight relays to flush; \
                     recorded WebSocket/streaming HAR entries may be missing or truncated"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Delete a session entirely — clears plugin data and removes from the map.
    pub async fn delete_session(&self, session_id: &SessionId) -> Result<(), SessionError> {
        {
            let mut sessions = self.sessions_lock.write();
            sessions.remove(session_id).ok_or(SessionError::NotFound)?;
        }
        self.registry.on_session_clear(session_id).await;

        // Clean up iteration counter.
        self.iteration_store.delete(session_id).await;

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

    /// Mark a proxy request as in flight on this session, also touching the
    /// idle timer. Pair every call with [`Self::end_request`] (use the
    /// [`InFlightGuard`] RAII wrapper to make this automatic).
    ///
    /// Returns `true` if the session was found and the counter was incremented.
    pub fn begin_request(&self, session_id: &SessionId) -> bool {
        let mut sessions = self.sessions_lock.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.in_flight = session.in_flight.saturating_add(1);
            session.last_activity = Instant::now();
            debug!(
                session_id = %session_id,
                in_flight = session.in_flight,
                "begin_request: incremented in-flight counter"
            );
            true
        } else {
            debug!(
                session_id = %session_id,
                "begin_request: session not found (already reaped or never created)"
            );
            false
        }
    }

    /// Mark a proxy request as no longer in flight, also touching the idle
    /// timer so the next idle window starts from request completion.
    pub fn end_request(&self, session_id: &SessionId) {
        let mut sessions = self.sessions_lock.write();
        if let Some(session) = sessions.get_mut(session_id) {
            session.in_flight = session.in_flight.saturating_sub(1);
            session.last_activity = Instant::now();
            debug!(
                session_id = %session_id,
                in_flight = session.in_flight,
                "end_request: decremented in-flight counter"
            );
        }
    }

    /// Number of in-flight requests for a session (test/diagnostic helper).
    #[cfg(test)]
    pub fn in_flight_count(&self, session_id: &SessionId) -> u32 {
        self.sessions_lock
            .read()
            .get(session_id)
            .map(|s| s.in_flight)
            .unwrap_or(0)
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
    ///
    /// Sessions with `in_flight > 0` are never reaped, regardless of their
    /// `last_activity`. A long-running streaming response (e.g. an 8-minute
    /// Claude completion) does not touch the session until the body fully
    /// drains, so reaping mid-stream would tear down the `plugin`
    /// plugin's per-session state and cause the gateway to stop injecting
    /// the bearer token, surfacing as `407 Proxy authentication required`
    /// from the upstream's perspective. See #818.
    pub async fn reap_idle(&self) -> Vec<SessionId> {
        let reaped: Vec<SessionId> = {
            let mut sessions = self.sessions_lock.write();
            let now = Instant::now();
            let mut reaped = Vec::new();
            sessions.retain(|id, session| {
                let idle_for = now.duration_since(session.last_activity);
                if idle_for > self.idle_timeout {
                    if session.in_flight == 0 {
                        reaped.push(id.clone());
                        false
                    } else {
                        // Idle window elapsed but a request is still streaming;
                        // keep the session alive. This is the load-bearing branch
                        // for the long-running-response fix — surface it at INFO
                        // so we can confirm the guard is firing in production.
                        info!(
                            session_id = %id,
                            in_flight = session.in_flight,
                            idle_secs = idle_for.as_secs(),
                            "reap_idle: skipping idle session with in-flight requests"
                        );
                        true
                    }
                } else {
                    true
                }
            });
            reaped
        };
        for id in &reaped {
            self.registry.on_session_clear(id).await;
            self.iteration_store.delete(id).await;
        }
        reaped
    }

    /// Number of sessions.
    pub fn session_count(&self) -> usize {
        self.sessions_lock.read().len()
    }

    /// Read the current iteration for a session.
    pub async fn get_iteration(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<u32>, anyhow::Error> {
        self.iteration_store.get(session_id).await
    }

    /// Atomic compare-and-swap rotation of the session iteration counter.
    pub async fn rotate(
        &self,
        session_id: &SessionId,
        expected: u32,
    ) -> Result<crate::iteration_store::CasResult, SessionError> {
        {
            let sessions = self.sessions_lock.read();
            if !sessions.contains_key(session_id) {
                return Err(SessionError::NotFound);
            }
        }

        let next_iteration = expected.saturating_add(1);
        self.registry
            .on_iteration_rotate(session_id, next_iteration)
            .await
            .map_err(|e| SessionError::RotatePrepareFailed(e.to_string()))?;

        Ok(self
            .iteration_store
            .compare_and_swap(session_id, expected)
            .await)
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
    #[error("failed to prepare rotation: {0}")]
    RotatePrepareFailed(String),
}

/// RAII guard that decrements a session's `in_flight` counter on drop.
///
/// Constructed via [`InFlightGuard::begin`]: increments the counter (and
/// touches the session) on construction, decrements it on drop. This makes
/// the in-flight tracking panic-safe and impossible to leak across early
/// returns in the proxy hot path.
pub struct InFlightGuard {
    manager: Arc<SessionManager>,
    session_id: SessionId,
}

impl InFlightGuard {
    /// Begin tracking an in-flight request. Returns `None` if the session no
    /// longer exists (caller should treat that as a 404 / disconnect).
    pub fn begin(manager: Arc<SessionManager>, session_id: SessionId) -> Option<Self> {
        if manager.begin_request(&session_id) {
            Some(Self {
                manager,
                session_id,
            })
        } else {
            None
        }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.manager.end_request(&self.session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iteration_store::CasResult;
    use crate::iteration_store::LocalIterationStore;
    use crate::plugin::{HttpExchange, PluginRegistry, ProxyPlugin, SessionId};
    use crate::session_store::SessionPersistence;
    use async_trait::async_trait;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn make_iteration_store() -> Arc<dyn IterationStore> {
        Arc::new(LocalIterationStore::new())
    }

    fn make_manager(max: usize) -> SessionManager {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        SessionManager::new(
            registry,
            Duration::from_secs(300),
            max,
            make_iteration_store(),
        )
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
    async fn stop_session_signals_cancel() {
        // A long-lived relay (e.g. a Codex Responses-over-WebSocket connection)
        // subscribes to the cancel signal; stopping the session must flip it to
        // true so the relay breaks and flushes its HAR entry.
        let mgr = make_manager(100);
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        let mut cancel_rx = mgr
            .subscribe_cancel(&"s1".into())
            .expect("session exists, receiver must be available");
        assert!(!*cancel_rx.borrow_and_update());

        mgr.stop_session(&"s1".into()).await.unwrap();

        // The receiver should now observe the cancellation.
        assert!(cancel_rx.has_changed().unwrap_or(true));
        assert!(*cancel_rx.borrow());
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
        let mgr = SessionManager::new(
            registry,
            Duration::from_millis(0),
            100,
            make_iteration_store(),
        );
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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

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
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

        let _ = mgr.stop_session(&"nonexistent".into()).await;
        assert_eq!(delete_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn create_session_with_store_uses_custom_ttl() {
        // Verify save is called (TTL correctness is a store concern, but we
        // confirm the path through session_ttl → store.save is exercised).
        let (mock, save_calls, _) = MockStore::new(true);
        let registry = Arc::new(PluginRegistry::new(vec![]));
        let mgr = SessionManager::new_with_store(
            registry,
            Duration::from_secs(300),
            100,
            mock,
            make_iteration_store(),
        );

        let mut settings = HashMap::new();
        settings.insert(
            "_maxSessionDurationSecs".to_string(),
            serde_json::json!(7200),
        );
        let result = mgr.create_session("s1".into(), settings).await.unwrap();
        assert!(result);
        assert_eq!(save_calls.load(Ordering::Relaxed), 1);
    }

    struct RotationRecordingPlugin {
        events: Arc<Mutex<Vec<&'static str>>>,
        fail_rotate: bool,
    }

    #[async_trait]
    impl ProxyPlugin for RotationRecordingPlugin {
        fn name(&self) -> &str {
            "rotation-recorder"
        }

        async fn on_session_start(&self, _session_id: &SessionId, _settings: &Value) {}

        async fn on_exchange(
            &self,
            _session_id: &SessionId,
            _exchange: &HttpExchange,
            _iteration: u32,
        ) {
        }

        async fn on_session_stop(&self, _session_id: &SessionId) {}

        async fn on_session_clear(&self, _session_id: &SessionId) {}

        async fn on_iteration_rotate(
            &self,
            _session_id: &SessionId,
            _next_iteration: u32,
        ) -> anyhow::Result<()> {
            self.events.lock().unwrap().push("plugin");
            if self.fail_rotate {
                anyhow::bail!("rotation setup failed")
            }
            Ok(())
        }
    }

    struct RecordingIterationStore {
        current: parking_lot::RwLock<std::collections::HashMap<String, u32>>,
        events: Arc<Mutex<Vec<&'static str>>>,
        cas_calls: Arc<AtomicUsize>,
    }

    impl RecordingIterationStore {
        fn new(events: Arc<Mutex<Vec<&'static str>>>, cas_calls: Arc<AtomicUsize>) -> Self {
            Self {
                current: parking_lot::RwLock::new(std::collections::HashMap::new()),
                events,
                cas_calls,
            }
        }
    }

    #[async_trait]
    impl IterationStore for RecordingIterationStore {
        async fn init(&self, session_id: &str, _ttl_secs: i64) {
            self.current.write().insert(session_id.to_string(), 1);
        }

        async fn get(&self, session_id: &str) -> Result<Option<u32>, anyhow::Error> {
            Ok(self.current.read().get(session_id).copied())
        }

        async fn compare_and_swap(&self, session_id: &str, expected: u32) -> CasResult {
            self.cas_calls.fetch_add(1, Ordering::Relaxed);
            self.events.lock().unwrap().push("cas");
            let mut current = self.current.write();
            match current.get_mut(session_id) {
                Some(cur) if *cur == expected => {
                    *cur = expected + 1;
                    CasResult::Ok(*cur)
                }
                Some(cur) => CasResult::Conflict(*cur),
                None => CasResult::Conflict(0),
            }
        }

        async fn delete(&self, session_id: &str) {
            self.current.write().remove(session_id);
        }
    }

    #[tokio::test]
    async fn rotate_prepares_plugin_before_cas() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let cas_calls = Arc::new(AtomicUsize::new(0));
        let plugin = Arc::new(RotationRecordingPlugin {
            events: events.clone(),
            fail_rotate: false,
        });
        let registry = Arc::new(PluginRegistry::new(vec![plugin]));
        let iteration_store = Arc::new(RecordingIterationStore::new(events.clone(), cas_calls));
        let mgr = SessionManager::new(registry, Duration::from_secs(300), 100, iteration_store);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        match mgr.rotate(&"s1".into(), 1).await.unwrap() {
            CasResult::Ok(next) => assert_eq!(next, 2),
            CasResult::Conflict(actual) => panic!("expected CAS success, got conflict {}", actual),
        }

        let got = events.lock().unwrap().clone();
        assert_eq!(got, vec!["plugin", "cas"]);
    }

    #[tokio::test]
    async fn rotate_returns_error_when_plugin_prepare_fails() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let cas_calls = Arc::new(AtomicUsize::new(0));
        let plugin = Arc::new(RotationRecordingPlugin {
            events,
            fail_rotate: true,
        });
        let registry = Arc::new(PluginRegistry::new(vec![plugin]));
        let iteration_store = Arc::new(RecordingIterationStore::new(
            Arc::new(Mutex::new(Vec::new())),
            cas_calls.clone(),
        ));
        let mgr = SessionManager::new(registry, Duration::from_secs(300), 100, iteration_store);

        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        let err = mgr.rotate(&"s1".into(), 1).await.unwrap_err();
        assert!(matches!(err, SessionError::RotatePrepareFailed(_)));
        assert_eq!(cas_calls.load(Ordering::Relaxed), 0);
    }

    // ---- in-flight / reaper tests (issue #818) -----------------------------

    fn make_manager_with_idle(max: usize, idle_timeout: Duration) -> SessionManager {
        let registry = Arc::new(PluginRegistry::new(vec![]));
        SessionManager::new(registry, idle_timeout, max, make_iteration_store())
    }

    #[tokio::test]
    async fn reap_skips_session_with_in_flight_request() {
        // Very short idle timeout to make the test fast.
        let mgr = Arc::new(make_manager_with_idle(10, Duration::from_millis(20)));
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        // Simulate a long-running streaming response: take a guard and hold it.
        let guard = InFlightGuard::begin(mgr.clone(), "s1".into()).expect("session must exist");
        assert_eq!(mgr.in_flight_count(&"s1".into()), 1);

        // Sleep well past the idle timeout, then reap.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let reaped = mgr.reap_idle().await;
        assert!(
            reaped.is_empty(),
            "session with in-flight request must not be reaped, got {:?}",
            reaped
        );
        assert!(mgr.is_active(&"s1".into()));

        // Drop the guard → counter goes to 0 and last_activity is touched.
        drop(guard);
        assert_eq!(mgr.in_flight_count(&"s1".into()), 0);

        // Immediately reaping should still skip (just touched).
        assert!(mgr.reap_idle().await.is_empty());

        // After another idle window, the session is reaped.
        tokio::time::sleep(Duration::from_millis(60)).await;
        let reaped = mgr.reap_idle().await;
        assert_eq!(reaped, vec!["s1".to_string()]);
        assert!(!mgr.is_active(&"s1".into()));
    }

    #[tokio::test]
    async fn in_flight_guard_balances_increment_and_decrement() {
        let mgr = Arc::new(make_manager_with_idle(10, Duration::from_secs(300)));
        mgr.create_session("s1".into(), HashMap::new())
            .await
            .unwrap();

        // Two concurrent in-flight requests.
        let g1 = InFlightGuard::begin(mgr.clone(), "s1".into()).unwrap();
        let g2 = InFlightGuard::begin(mgr.clone(), "s1".into()).unwrap();
        assert_eq!(mgr.in_flight_count(&"s1".into()), 2);

        drop(g1);
        assert_eq!(mgr.in_flight_count(&"s1".into()), 1);

        // Even with one still in-flight, reaper must skip.
        // (idle_timeout is 300s here so this is the "obviously safe" case.)
        let mgr_short = Arc::new(make_manager_with_idle(10, Duration::from_millis(10)));
        mgr_short
            .create_session("s2".into(), HashMap::new())
            .await
            .unwrap();
        let _g = InFlightGuard::begin(mgr_short.clone(), "s2".into()).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(mgr_short.reap_idle().await.is_empty());

        drop(g2);
        assert_eq!(mgr.in_flight_count(&"s1".into()), 0);
    }

    #[tokio::test]
    async fn in_flight_guard_returns_none_for_unknown_session() {
        let mgr = Arc::new(make_manager_with_idle(10, Duration::from_secs(300)));
        // No create_session — id is unknown.
        assert!(InFlightGuard::begin(mgr, "nope".into()).is_none());
    }
}
