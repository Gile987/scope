# Judge — Service, Autoscaling & In-Flight Concurrency Tracker

## Overview

The **judge** (`apps/judge/`) is the evaluation engine. It scores a coding
agent's workspace snapshot against a criteria DAG using the GitHub Copilot SDK,
with two strategies — `bundled` (all criteria in one session) or `independent`
(topological order, skipping descendants of failures). How criteria are *loaded*
and what *evidence* a criterion can see at evaluation time is covered in
[criteria-provider.md](criteria-provider.md); this document covers the judge as a
**runtime service**: its HTTP surface, how it autoscales, and the in-flight
concurrency tracker that drives that autoscaling.

It is an Express app. In-cluster it listens on port 80 behind the `judge-service`
ClusterIP and exposes:

| Route | Purpose |
|-------|---------|
| `POST /api/v1/evaluate` | Run an evaluation. Called mid-run by **every coder worker** and by the **post-processor** — so this one endpoint aggregates all judge load. |
| `GET /scaler/load` | Autoscaler signal: `{ "inFlight": n }` — the true, cluster-wide count of evaluations currently running. |
| `GET /health` | Liveness / readiness / startup probe target. |

## Autoscaling on true concurrency

The judge is **not** a queue worker — it is a synchronous HTTP service called on
the hot path of other workers' runs. Queue depth therefore tells us nothing about
its load. Instead it autoscales on **actual in-flight evaluations** via a KEDA
[`metrics-api`](https://keda.sh/docs/latest/scalers/metrics-api/) `ScaledObject`
(`deploy/base/judge.yaml`) that polls `GET /scaler/load`:

```yaml
triggers:
  - type: metrics-api
    metadata:
      url: "http://judge-service.scoped.svc.cluster.local/scaler/load"
      valueLocation: "inFlight"
      targetValue: "3"
# minReplicaCount: 2, maxReplicaCount: 6, pollingInterval: 15s, cooldownPeriod: 60s
```

The default metric type is `AverageValue`, so KEDA computes
`desiredReplicas = ceil(inFlight / targetValue)`. With `targetValue: "3"` and a
2–6 replica band, the judge holds at 2 replicas up to 6 concurrent evals and
reaches full fan-out (6) at 18 concurrent evals. `metrics-api` is an in-cluster
HTTP GET, so no `authenticationRef`/`TriggerAuthentication` is needed.

Because there are multiple judge replicas but the scaler needs **one** global
number, the count cannot live in a replica's memory — it lives in Redis, shared
across all replicas.

## The in-flight tracker (`apps/judge/src/inflight-tracker.ts`)

Each evaluation registers a marker in a **Redis sorted set** (`ZSET`) named
`judge:inflight` for its lifetime:

- **member** = a random UUID, one per in-flight evaluation
- **score** = the epoch-millisecond timestamp when that evaluation started

`POST /api/v1/evaluate` calls `begin()` on entry and `end()` in a `finally` (so it
clears on both success and error). `GET /scaler/load` calls `load()`.

```
begin()  ->  ZADD judge:inflight <now-ms> <uuid>          # O(log N)
end(id)  ->  ZREM judge:inflight <uuid>                    # O(log N)  (in finally)
load()   ->  ZREMRANGEBYSCORE judge:inflight 0 <now-15min> # prune dead markers
             ZCARD judge:inflight                          # O(1) exact count
```

So `load()` reads *"garbage-collect anything too old to still be alive, then count
what's left."* The prune window is `JUDGE_MAX_EVAL_AGE_MS` (default 900000 =
15 min), set comfortably above the longest expected evaluation
(`JUDGE_CLIENT_TIMEOUT`).

### Why a sorted set and not a shared counter?

The obvious alternative is an integer counter: `INCR judge:inflight` on entry,
`DECR` on completion, `GET` to read. It is O(1) and tiny — but it has one fatal
property for this use case: **it is not self-healing.**

If a request increments but never decrements — and that is exactly the failure
mode this whole effort targets (issue #1316: judge pods getting SIGKILLed /
liveness-killed mid-eval, so the `finally` never runs), plus pod evictions,
crashes, and network partitions — the counter is now permanently too high and
**never recovers**. For an autoscaler input that is catastrophic: a leaked count
would pin the judge at `maxReplicaCount` forever, or drift upward until someone
manually resets the key. A bare integer has no per-entry identity or age, so you
cannot tell which increments are stale and undo only those.

The sorted set fixes this precisely because every in-flight request is
**individually identified (UUID)** and **individually timestamped (score)**:

| Property | Shared counter (`INCR`/`DECR`) | Sorted set (this design) |
|----------|--------------------------------|--------------------------|
| Read cost | O(1) `GET` | O(1) `ZCARD` |
| Memory | O(1) | O(N) — one small entry per in-flight eval (N is tens at most) |
| Self-healing on crash | ❌ leaks forever; drifts up monotonically | ✅ each entry carries its start time, so `ZREMRANGEBYSCORE` reaps **only** entries older than the window, never live ones |
| Duplicate/retry safe | ❌ a double `DECR` under-counts, can go negative | ✅ `ZREM <uuid>` targets one member; running it twice is a no-op |

The costs the ZSET pays — O(N) memory and O(log N) writes — are negligible at
this scale, and the count is allowed to be slightly **approximate at the edges**
(a genuinely >15-min eval gets pruned and under-counted; a just-crashed one is
counted until the window elapses). That is fine for a scaler signal. An
alternative that is also leak-safe would be per-request TTL keys
(`SET judge:inflight:<uuid> 1 EX 900`), but counting them means an O(N) `SCAN`;
the ZSET gives leak-safety **and** an O(1) exact count in one structure.

### Fail-safe and best-effort semantics

Redis is a **scaling optimization, never a correctness dependency** for
evaluation:

- Every tracker call is wrapped so a Redis error can never propagate to the
  evaluation path — a failed `begin()`/`end()` just means a slightly inaccurate
  count.
- `load()` **fails safe to `0`** when Redis is unavailable, so the scaler holds
  at `minReplicaCount` (2) rather than flapping.
- When `REDIS_HOST` is unset the tracker is constructed with a `null` client
  (`InflightTracker.fromEnv()`) and every method no-ops; `/scaler/load` reports
  `0`. This keeps local/dev judges running with no Redis.
- The client uses `enableOfflineQueue: false` deliberately: `begin()` is awaited
  on the evaluate hot path and must fail fast rather than queue while Redis is
  down.

### Cluster-safety

The Redis backend is **Azure Cache for Redis Enterprise with OSS clustering
policy**. Like every other Redis client in this repo, the tracker is a
**standalone** ioredis client (not `Redis.Cluster`), and it stays cluster-safe by
construction: **every** command targets the single key `judge:inflight`.
Single-key commands always route to their owning hash slot, so the tracker never
issues a cross-slot (`CROSSSLOT`) command. Cross-slot hazards only arise with
multi-key commands such as `MGET` — see
[`packages/shared/src/queue/cluster-safe-mget.ts`](../../packages/shared/src/queue/cluster-safe-mget.ts)
and issue #1064 for the one place that matters. TLS configuration follows the
repo-canonical inference (an explicit `REDIS_TLS=true` wins, else infer from a
password on a non-local host), matching `LogPublisher` and `RedisHeartbeatStore`.

The client is injected via the constructor (`new InflightTracker(redis, options)`)
and built from the environment by the static `InflightTracker.fromEnv()` factory.
This split keeps the connection logic in one place while making the counting
logic unit-testable with an in-memory fake (`inflight-tracker.test.ts`).

## Deployment hardening

The judge Deployment (`deploy/base/judge.yaml`) was hardened alongside the
tracker to stop the SIGKILL/`fetch failed` incidents (#1316). Full cluster/pool
context is in [deployment.md](deployment.md#app-tier-node-pool); the judge-specific
pieces:

- **Probes.** The liveness probe was relaxed from the k8s defaults (1s timeout /
  3 failures) to `timeoutSeconds: 5` / `failureThreshold: 5`, because under load a
  1s probe timed out and k8s SIGKILLed the pod (exit 137 — *not* OOM). A
  `startupProbe` (`/health`, `failureThreshold: 30`, `periodSeconds: 10` → up to
  5 min) gates liveness so a slow cold start or boot-time GC pause can't trip it.
- **Resources.** `requests: { cpu: 200m, memory: 1Gi }`,
  `limits: { cpu: "1", memory: 2Gi }`. The CPU limit was deliberately left at 1;
  memory was raised (1Gi→2Gi limit, 512Mi→1Gi request).
- **Replicas.** No static `spec.replicas` — the KEDA `ScaledObject` owns the
  `/scale` subresource (its `minReplicaCount: 2` is the floor) so Flux and KEDA
  don't fight.
- **Rollout.** A normal rolling update (`maxSurge: 1, maxUnavailable: 0`), now
  that the judge runs on the non-constrained `apps` pool. `podAntiAffinity`
  spreads replicas across hostnames.
- **PodDisruptionBudget.** `maxUnavailable: 1` keeps ≥1 judge serving during node
  drains / apps-pool scale-in without blocking them (pairs with the KEDA floor of
  2).

## Configuration

Relevant environment variables (full reference in
[ENV_VARIABLES.md](../../ENV_VARIABLES.md)):

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_HOST` | *(unset)* | Enables the tracker. Unset → tracker no-ops, `/scaler/load` reports 0. |
| `REDIS_PORT` | `6300` | Redis port. |
| `REDIS_PASSWORD` | *(unset)* | Redis auth; also drives TLS inference. |
| `REDIS_TLS` | *(inferred)* | Force TLS on/off; overrides inference. |
| `JUDGE_MAX_EVAL_AGE_MS` | `900000` (15 min) | Stale-marker prune window for `load()`. Set above the longest expected eval. |

## Related

- [deployment.md](deployment.md) — `apps` node pool pin, KEDA on the app tier, PDB.
- [criteria-provider.md](criteria-provider.md) — how criteria are loaded and what evidence a criterion can see.
- [post-processing.md](post-processing.md) — the post-processor is one of the callers of `POST /api/v1/evaluate`.
