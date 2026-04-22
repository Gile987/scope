# Design Document: LLM Gateway for Claude/Anthropic Rate-Limit Resilience

## 1. Problem Statement

The `coder-acp-claude-code` worker is a KEDA-scaled Kubernetes pod that spawns `claude-agent-acp` as a **subprocess** for each eval task. The subprocess makes all Anthropic API calls directly using the token injected via `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

Anthropic's rate limits (RPM/ITPM/OTPM + longer rolling daily/weekly/monthly caps) cause frequent `429 Too Many Requests` failures. When the subprocess hits a 429, it exits non-zero. The parent Node.js worker sees `ACP agent process exited unexpectedly (code 1)`, marks the run `outcome: failed`, and the task is lost — no retry, no backoff.

**Current mitigations** (insufficient on their own):

- KEDA `maxReplicaCount: 2` on the `ScaledObject` — limits parallelism but does not handle bursts within a single subscription.
- Token Manager round-robin across multiple keys — helps distribute load but doesn't retry on 429.

**Core requirements**:

- Graceful degradation instead of hard failures (slow down rather than crash).
- Stay within account limits without constant manual tuning.
- Preserve existing KEDA worker scaling logic.
- Compatible with the .NET Dev Proxy HAR capture sidecar already deployed in every worker pod.
- Minimal code changes to workers — no changes to `claude-agent-acp` itself.
- Future-proof for more advanced behaviors (dynamic throttling, observability).

---

## 2. Why Standard Retry Approaches Don't Work Here

The Anthropic SDK is not used anywhere in the codebase — all API calls are made by the `claude-agent-acp` subprocess (a compiled Claude Code CLI binary). There is no Node.js SDK client to configure `max_retries` on.

The `withRetry` utility in `packages/shared/src/utils/retry.ts` (backed by cockatiel) handles CosmosDB 429s but is only called around MongoDB operations. It is not wrapped around `processMessage` in `multi-turn-loop.ts`, and even if it were, it would restart the entire subprocess from scratch — not resume mid-session.

The subprocess exit error message (`ACP agent process exited unexpectedly`) does not carry enough detail to reliably detect rate-limit vs. other failures, making error-based retry fragile.

The right fix is to intercept the 429 **before it reaches the subprocess** — at the network layer.

---

## 3. Proposed Solution

Deploy **Bifrost** (https://github.com/maximhq/bifrost) — an open-source, high-performance LLM gateway written in Go — as a lightweight reverse proxy in front of Anthropic.

The subprocess is pointed at Bifrost via a single env var: `ANTHROPIC_BASE_URL`. Claude Code CLI respects this env var and routes all API traffic through it. Bifrost handles back-pressure and 429 retries transparently — the subprocess never sees a rate-limit failure.

---

## 4. How Bifrost Solves the Problem

Bifrost addresses ~70-80% of the problem through two complementary mechanisms:

**Proactive per-provider queue + back-pressure** (the primary fix)

Each provider (Anthropic) gets its own isolated **buffered Go channel queue** + dedicated worker goroutine pool. Configurable via `concurrencyAndBufferSize`:

```json
{
  "maxConcurrency": 25,
  "bufferSize": 100
}
```

- When the concurrency limit is reached, incoming requests **block** in the queue (`drop_excess_requests: false` — default).
- Workers experience only **added latency** instead of a subprocess crash.
- Runs continue uninterrupted — the session slows gracefully rather than failing.

**Reactive 429 handling**

On a real `429` response from Anthropic:

- Automatic exponential backoff + jitter retries (configurable `maxRetries`, `retryBackoffInitial`, `retryBackoffMax`).
- The subprocess call still completes successfully from the caller's perspective.

**Key benefits**:

- Zero failed runs due to rate limits.
- Works with existing KEDA-scaled workers (no scaling logic changes needed).
- Full observability (logs, Prometheus, OpenTelemetry).
- Single binary / microservice footprint.

---

## 5. Code Change: Forwarding `ANTHROPIC_BASE_URL` to the Subprocess

The worker builds a subprocess env object in `apps/workers/coder-acp-claude-code/src/index.ts` and passes it to `runACPSession`, which merges it with `process.env` before spawning `claude-agent-acp`. The subprocess **only** receives explicitly forwarded keys — ambient env vars are not automatically passed through.

The following change was made to forward `ANTHROPIC_BASE_URL` when set on the worker process:

```ts
// apps/workers/coder-acp-claude-code/src/index.ts
if (options?.model) {
  env.ANTHROPIC_MODEL = options.model;
}
// Forward Bifrost/proxy base URL if configured (e.g. ANTHROPIC_BASE_URL=http://bifrost:8080)
if (process.env.ANTHROPIC_BASE_URL) {
  env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
}
```

This is intentionally conditional — if `ANTHROPIC_BASE_URL` is not set, the subprocess falls back to the default `https://api.anthropic.com` and there is no behavioral change.

---

## 6. Deployment Options

### Local Development (Docker Compose)

The `coder-acp-claude-code` service in `docker-compose.yml` already has a Dev Proxy sidecar (`devproxy-claude-code`) configured to watch `https://api.anthropic.com/*` and capture HAR files. Bifrost slots in between Dev Proxy and Anthropic.

Dev Proxy uses its `RedirectCalls` plugin to rewrite `api.anthropic.com` → `http://bifrost:8080/anthropic`. The `HarGeneratorPlugin` still captures full original traffic, so HAR capture is unaffected.

```yaml
# Add to docker-compose.yml (alongside devproxy-claude-code)
services:
  bifrost:
    image: maximhq/bifrost:latest
    ports: ["8082:8080"]
    volumes: ["./bifrost-data:/app/data"]
    profiles: [claude-code]

  coder-acp-claude-code:
    environment:
      # ... existing env vars ...
      ANTHROPIC_BASE_URL: "http://bifrost:8080/anthropic"
```

The Dev Proxy config at `apps/workers/coder-acp-claude-code/devproxy-config.json` currently watches `https://api.anthropic.com/*` for HAR generation. When Bifrost is in the path, add a `RedirectCalls` plugin entry:

```json
{
  "urlsToWatch": ["https://api.anthropic.com/*"],
  "plugins": [
    { "name": "HarGeneratorPlugin", ... },
    {
      "name": "RedirectCalls",
      "enabled": true,
      "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
      "configSection": "redirectCalls"
    }
  ],
  "redirectCalls": {
    "redirects": [
      { "sourceUrl": "https://api.anthropic.com/*", "targetUrl": "http://bifrost:8080/anthropic/*" }
    ]
  }
}
```

### Production / Staging (Kubernetes)

The worker pod in `deploy/base/workers/coder-acp-claude-code.yaml` already has two sidecars (DevProxy on port 18000 and MCPJungle on port 8080). Bifrost deploys as a separate `ClusterIP` service in the `scoped` namespace — not as a per-pod sidecar, since a single Bifrost instance can serve all replicas.

```yaml
# deploy/base/bifrost-deployment.yaml (new file)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bifrost
  namespace: scoped
spec:
  replicas: 2
  selector:
    matchLabels:
      app: bifrost
  template:
    spec:
      containers:
        - name: bifrost
          image: maximhq/bifrost:latest
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: bifrost
  namespace: scoped
spec:
  type: ClusterIP
  selector:
    app: bifrost
  ports:
    - port: 8080
      targetPort: 8080
```

Add the env var to the worker Deployment in `coder-acp-claude-code.yaml`:

```yaml
env:
  - name: ANTHROPIC_BASE_URL
    value: "http://bifrost.scoped.svc.cluster.local:8080/anthropic"
```

The existing `NO_PROXY` list in the Deployment (`localhost,127.0.0.1,...`) must **not** include `bifrost` — the worker needs to reach it via the proxy path.

---

## 7. Interaction with Dev Proxy (HAR Capture)

In production, the worker pod runs a Dev Proxy sidecar (`ghcr.io/dotnet/dev-proxy:2.1.0`) on `localhost:18000`. Currently Dev Proxy intercepts `https://api.anthropic.com/*` via the `HTTP_PROXY`/`HTTPS_PROXY` env vars set on the worker container.

With Bifrost in the path: the subprocess's traffic goes `claude-agent-acp → Bifrost → Anthropic`. Dev Proxy no longer sits in the hot path by default. Two options:

1. **Keep Dev Proxy in front of Bifrost** — set `HTTP_PROXY=http://localhost:18000` on the subprocess env (already done when DevProxy is enabled), and configure Dev Proxy to forward to Bifrost. This preserves HAR capture.
2. **Let Bifrost handle HAR** — use a custom Bifrost plugin (see section 9). Simpler topology, but requires plugin development.

Option 1 is the safer path for now since Dev Proxy is already wired into the worker pod and the `devproxy-config.json` is already scoped to `api.anthropic.com/*`.

---

## 8. Trade-offs & Shortcomings

| Limitation            | Detail                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Static throttling     | `maxConcurrency` is always enforced — workers are slowed even when Anthropic has spare capacity.                    |
| No dynamic adjustment | Open-source Bifrost does not automatically reduce concurrency on 429s. Adaptive load balancing is Enterprise-only.  |
| Single-key limitation | No automatic key rotation (though 429 retries/backoff still help). Token Manager round-robin is a separate layer.   |
| HAR generation        | Not built-in — handled by Dev Proxy sidecar in both local dev and K8s. Requires coordinating the two systems.       |
| Bifrost as SPOF       | A shared ClusterIP Bifrost instance is a single point of failure. Mitigate with `replicas: 2` and readiness probes. |

---

## 9. Future Extensibility – Plugin Model

Bifrost has a first-class **middleware-style Go plugin architecture** (`PreLLMHook` / `PostLLMHook`, `HTTPTransportPlugin`, etc.).

Custom additions we can easily add:

- Dynamic throttling (inspect 429s or rate-limit headers and adjust concurrency at runtime).
- Native HAR file generation (accumulate requests/responses and write `.har` files — would remove the need for the Dev Proxy sidecar).
- Token rotation (call Token Manager on 401/403 to swap API keys without a worker restart).

Plugins are compiled as shared libraries and loaded at runtime — no core Bifrost changes required.

---

## 10. Implementation Steps

1. Deploy Bifrost locally via Docker Compose (add service to `docker-compose.yml`, add `ANTHROPIC_BASE_URL` to `coder-acp-claude-code` service).
2. Configure Anthropic provider + conservative `maxConcurrency`/`bufferSize` via Bifrost UI.
3. Run one eval scenario end-to-end and verify HAR files are still captured by Dev Proxy.
4. Tune `maxConcurrency` and `bufferSize` based on observed queue depth / latency from Bifrost metrics.
5. Add `bifrost` Deployment + Service to `deploy/base/` (new manifest file).
6. Add `ANTHROPIC_BASE_URL` env var to `deploy/base/workers/coder-acp-claude-code.yaml`.
7. Deploy to integration environment and monitor via Bifrost built-in UI / Prometheus / OTel.
8. _(Future)_ Add custom plugin for dynamic throttling or native HAR support.

---

## 11. Open Questions

| Question                                                              | Context                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should the gateway serve all workers or only `coder-acp-claude-code`? | Claude is currently the only worker experiencing rate-limit failures. Copilot workers use the GitHub-managed Copilot API (which has its own quota handling) and do not hit Anthropic. Routing all workers through Bifrost adds operational complexity and a shared failure domain with no benefit for non-Anthropic workers. The simpler default is to scope Bifrost exclusively to `coder-acp-claude-code` and revisit if other workers start hitting provider limits. |
| What is the right initial `maxConcurrency` value?                     | `maxReplicaCount: 2` on the KEDA `ScaledObject` bounds the number of parallel workers, but each worker may make multiple concurrent requests per task. The correct value needs to be measured against real eval runs before being set in production.                                                                                                                                                                                                                    |
| Should Bifrost replace or supplement the Dev Proxy sidecar?           | Dev Proxy is currently wired into the worker pod for HAR capture. With Bifrost in the path, their interaction needs to be explicitly designed (see section 7). Until a Bifrost HAR plugin exists, Dev Proxy must stay in the chain.                                                                                                                                                                                                                                     |

---

## 12. Next Steps / Recommendations

- Start with the Docker Compose setup to validate behavior on a single eval run before touching K8s.
- Measure real-world latency impact vs. current failure rate (baseline: check how many `outcome: failed` runs have "ACP agent process exited" in logs).
- If static throttling proves sufficient, roll out to staging.
- Keep `maxReplicaCount: 2` on the KEDA `ScaledObject` as an additional guard — Bifrost and KEDA limits are complementary, not redundant.
- If fully dynamic behavior becomes critical, prototype a custom plugin (low effort given the architecture).
