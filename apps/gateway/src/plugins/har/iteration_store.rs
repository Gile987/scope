// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Redis-backed iteration counter for multi-replica consistency.
//!
//! Each gateway session has a mutable iteration counter that is bumped by the
//! `POST /rotate` endpoint. Because session affinity is best-effort (not
//! guaranteed), the authoritative counter lives in Redis so that any replica
//! can read the current value or perform a compare-and-swap rotation.
//!
//! Redis key: `gateway:session:{sessionId}:iteration`
//!
//! The key shares the same TTL as the session key itself and is cleaned up
//! when the session is cleared.

use async_trait::async_trait;

/// Result of a compare-and-swap rotation attempt.
pub enum CasResult {
    /// The CAS succeeded — contains the new iteration value.
    Ok(u32),
    /// The CAS failed — contains the actual current value.
    Conflict(u32),
}

/// Trait abstracting the iteration counter store (Redis, mock, etc.).
#[async_trait]
pub trait IterationStore: Send + Sync {
    /// Initialise the counter for a new session (sets it to 1).
    async fn init(&self, session_id: &str, ttl_secs: i64);

    /// Read the current iteration value.
    /// Returns `Ok(Some(n))` on success, `Ok(None)` if the key is absent,
    /// or `Err` if the store is unreachable after retries.
    async fn get(&self, session_id: &str) -> anyhow::Result<Option<u32>>;

    /// Atomic compare-and-swap: if current == expected, increment to expected+1.
    /// Returns `Ok(new)` on success, `Conflict(actual)` on mismatch.
    async fn compare_and_swap(&self, session_id: &str, expected: u32) -> CasResult;

    /// Delete the counter (session cleanup).
    async fn delete(&self, session_id: &str);
}

fn iteration_key(session_id: &str) -> String {
    format!("gateway:session:{}:iteration", session_id)
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

/// Redis-backed `IterationStore` using `fred`.
pub struct RedisIterationStore {
    client: fred::prelude::Client,
}

impl RedisIterationStore {
    pub fn new(client: fred::prelude::Client) -> Self {
        Self { client }
    }
}

/// Lua script for atomic CAS: if current == ARGV[1], INCR and return new
/// value; otherwise return the current value negated (so caller can
/// distinguish success from conflict).
///
/// Returns:
///   positive N  → CAS succeeded, N is the new value
///   negative -N → CAS failed, |N| is the actual current value
///   0           → key does not exist
const CAS_SCRIPT: &str = r#"
local cur = tonumber(redis.call('GET', KEYS[1]))
if cur == nil then return 0 end
if cur == tonumber(ARGV[1]) then
  return redis.call('INCR', KEYS[1])
else
  return -cur
end
"#;

#[async_trait]
impl IterationStore for RedisIterationStore {
    async fn init(&self, session_id: &str, ttl_secs: i64) {
        use fred::interfaces::KeysInterface;
        use fred::types::{Expiration, SetOptions};
        let key = iteration_key(session_id);
        let _: () = self
            .client
            .set(
                &key,
                1i64,
                Some(Expiration::EX(ttl_secs)),
                None::<SetOptions>,
                false,
            )
            .await
            .unwrap_or(());
    }

    async fn get(&self, session_id: &str) -> anyhow::Result<Option<u32>> {
        use fred::interfaces::KeysInterface;
        let key = iteration_key(session_id);
        // fred's built-in ReconnectPolicy handles transient connection errors;
        // we just propagate the final result.
        let val: Option<i64> = self.client.get(&key).await?;
        Ok(val.map(|v| v as u32))
    }

    async fn compare_and_swap(&self, session_id: &str, expected: u32) -> CasResult {
        use fred::interfaces::LuaInterface;
        let key = iteration_key(session_id);
        let result: i64 = self
            .client
            .eval(CAS_SCRIPT, vec![key], vec![expected as i64])
            .await
            .unwrap_or(0);

        if result > 0 {
            CasResult::Ok(result as u32)
        } else if result < 0 {
            CasResult::Conflict((-result) as u32)
        } else {
            // Key missing — treat as conflict with iteration 0
            CasResult::Conflict(0)
        }
    }

    async fn delete(&self, session_id: &str) {
        use fred::interfaces::KeysInterface;
        let key = iteration_key(session_id);
        let _: () = self.client.del(&key).await.unwrap_or(());
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use parking_lot::RwLock;
    use std::collections::HashMap;

    /// In-memory mock for unit tests (no Redis required).
    pub struct MockIterationStore {
        state: RwLock<HashMap<String, u32>>,
    }

    impl MockIterationStore {
        pub fn new() -> Self {
            Self {
                state: RwLock::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl IterationStore for MockIterationStore {
        async fn init(&self, session_id: &str, _ttl_secs: i64) {
            self.state
                .write()
                .insert(iteration_key(session_id), 1);
        }

        async fn get(&self, session_id: &str) -> anyhow::Result<Option<u32>> {
            Ok(self.state.read().get(&iteration_key(session_id)).copied())
        }

        async fn compare_and_swap(&self, session_id: &str, expected: u32) -> CasResult {
            let key = iteration_key(session_id);
            let mut state = self.state.write();
            match state.get_mut(&key) {
                Some(cur) if *cur == expected => {
                    *cur = expected + 1;
                    CasResult::Ok(expected + 1)
                }
                Some(cur) => CasResult::Conflict(*cur),
                None => CasResult::Conflict(0),
            }
        }

        async fn delete(&self, session_id: &str) {
            self.state.write().remove(&iteration_key(session_id));
        }
    }

    #[tokio::test]
    async fn mock_store_lifecycle() {
        let store = MockIterationStore::new();
        let sid = "test-session";

        // Before init
        assert_eq!(store.get(sid).await.unwrap(), None);

        // Init
        store.init(sid, 3600).await;
        assert_eq!(store.get(sid).await.unwrap(), Some(1));

        // CAS success
        match store.compare_and_swap(sid, 1).await {
            CasResult::Ok(v) => assert_eq!(v, 2),
            CasResult::Conflict(_) => panic!("expected Ok"),
        }
        assert_eq!(store.get(sid).await.unwrap(), Some(2));

        // CAS conflict (stale expected)
        match store.compare_and_swap(sid, 1).await {
            CasResult::Ok(_) => panic!("expected Conflict"),
            CasResult::Conflict(v) => assert_eq!(v, 2),
        }

        // Delete
        store.delete(sid).await;
        assert_eq!(store.get(sid).await.unwrap(), None);
    }
}
