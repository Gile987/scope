# Gateway TLA+ Specification

Formal specification of the Scope MT gateway's session lifecycle, HAR recording, and idle reaper. Verified with the TLC model checker.

## What is modeled

| Aspect | TLA+ Action | Production code |
|--------|-------------|-----------------|
| **Session creation** | `CreateSession(ip)` | `POST /api/v1/sessions` → `SessionManager::create_session` |
| **IP conflict resolution** | `CreateSession(ip)` (existing slot branch) | Old session cleared when same IP creates a new one |
| **Proxy request recording** | `ProxyRequest(ip)` | CONNECT/HTTP handler → `on_exchange` plugin hook |
| **HAR blob write failure** | `HarWriteFail(slot)` | `BlobWriter::append_with_retry` timeout → `failed=true` |
| **Failed request rejection** | `ProxyRequestFailed(ip)` | `on_request` returns error → 502 Bad Gateway |
| **Session stop** | `StopSession(slot)` | `POST /api/v1/sessions/{id}/stop` → `on_session_stop` |
| **Session delete** | `DeleteSession(slot)` | `DELETE /api/v1/sessions/{id}` → `on_session_clear` |
| **Idle reaper** | `ReapIdle(slot)` | Background tokio task, 60s interval, 300s idle threshold |
| **Time progression** | `Tick` | Abstract clock advancing |

## Safety properties verified (exhaustive)

All invariants checked over the complete reachable state space — no violations found.

| Invariant | What it ensures |
|-----------|-----------------|
| `UniqueIPPerSession` | No two active sessions share the same client IP |
| `CapacityRespected` | Allocated sessions never exceed `MaxSessions` |
| `HarOnlyWhenRecording` | HAR entries only exist for sessions that were recording |
| `StoppedImpliesFinalized` | A stopped session always has finalized or failed HAR state |
| `FreeSlotClean` | Free slots have no residual state (IP=NULL, HAR=None, entries=false) |
| `AllocatedHasIP` | Active or stopped slots always have a client IP assigned |
| `ActiveHarState` | Active sessions are always in Recording or HarFailed state |

## Liveness properties

| Property | Status | Notes |
|----------|--------|-------|
| `IdleSessionsEventuallyReaped` | Requires SF | Under weak fairness (WF), a proxy request can reset the idle timer before the reaper fires. This is expected real-world behavior. Strong fairness (SF) or a reformulated property ("if no more requests arrive, eventually reaped") would pass. |

## Verification results

```
Model: 2 IPs, 2 slots, MaxSessions=2, IdleTimeout=2, MaxTicks=4
  → 51,133 states generated, 10,981 distinct states, depth 14
  → All 8 safety invariants PASS ✓

Model: 3 IPs, 3 slots, MaxSessions=2, IdleTimeout=2, MaxTicks=4
  → 383,063 states generated, 78,611 distinct states, depth 13
  → All 8 safety invariants PASS ✓
```

## Running the model checker

### Prerequisites

Java 11+ and the TLA+ tools JAR:

```bash
curl -L -o ~/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
```

### Check safety (exhaustive)

```bash
cd apps/gateway/tlaplus
java -XX:+UseParallelGC -jar ~/tla2tools.jar -config Gateway.cfg -workers auto Gateway.tla
```

### Model parameters

The default model uses small constants for tractable exhaustive checking:

| Constant | Default | Production equivalent |
|----------|---------|----------------------|
| `ClientIPs` | `{c1, c2}` | Any number of client IPs |
| `SessionSlots` | `{s1, s2}` | Pool of session IDs (up to 100) |
| `MaxSessions` | `2` | `100` |
| `IdleTimeoutTicks` | `2` | `300s` (5 minutes) |
| `MaxTicks` | `4` | Unbounded real time |

Increase for deeper exploration at the cost of longer checking time.

## Files

- [Gateway.tla](Gateway.tla) — TLA+ specification
- [Gateway.cfg](Gateway.cfg) — TLC model configuration
