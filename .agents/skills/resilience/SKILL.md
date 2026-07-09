---
name: resilience
description: >
  Apply resilience patterns (retry, backoff, circuit breaking) when writing or reviewing code that makes outbound HTTP/REST calls, database operations, or any I/O that can experience transient failures. Use this skill when:
  (1) writing new code that calls external services or APIs,
  (2) reviewing code that uses fetch, HTTP clients, or service-to-service calls,
  (3) adding queue consumers or workers that interact with remote systems,
  (4) debugging intermittent failures in production.
metadata:
  version: "1.0.0"
---

# Resilience Patterns

When writing or reviewing code that makes outbound calls (REST APIs, database operations, queue interactions), always consider transient failure handling.

## Core Principle

**Every outbound HTTP call should have a retry strategy unless there's a specific reason not to.** Network blips, temporary 503s, and connection resets are normal in distributed systems. Code without retry is fragile by default.

## Available Tools

This repo provides retry utilities in `packages/shared/src/utils/retry.ts`:

### `@Retry` decorator (preferred for methods)

```typescript
import { Retry } from "shared";

class MyWorker {
  @Retry({ maxRetries: 3, baseDelayMs: 1000, isRetryable: () => true })
  async callExternalService(): Promise<void> {
    const res = await fetch("http://api/endpoint", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}
```

### `withRetry` function (for inline/conditional logic)

```typescript
import { withRetry } from "shared";

const result = await withRetry(
  () => fetch("http://api/data").then(r => r.json()),
  { maxRetries: 3, baseDelayMs: 500, isRetryable: (err) => isTransient(err) }
);
```

## Decision Checklist

When you encounter an outbound call, ask:

1. **Is this call idempotent?** If yes (GET, PUT, DELETE with idempotency key) -> retry aggressively.
2. **Is this call non-idempotent?** If yes (POST creating resources) -> retry cautiously, only on network errors (never got a response), not on 5xx (server may have processed it).
3. **Is this best-effort?** (e.g., triggering reports, sending notifications) -> retry with try/catch at call site so failures don't propagate.
4. **Is this critical path?** (e.g., saving user data) -> retry and propagate failure if exhausted.

## What to Retry

| Condition | Retry? | Reason |
|-----------|--------|--------|
| Network error (ECONNREFUSED, ETIMEDOUT) | Yes | Transient connectivity issue |
| HTTP 429 (Too Many Requests) | Yes | Rate limiting, respect Retry-After header |
| HTTP 500, 502, 503, 504 | Yes | Server-side transient failures |
| HTTP 400, 401, 403, 404, 409 | No | Client errors indicate a permanent problem |
| DNS resolution failure | Yes (limited) | May be temporary DNS propagation |

## Configuration Defaults

For service-to-service calls within the cluster:
- `maxRetries: 3`
- `baseDelayMs: 1000` (1 second)
- `maxDelayMs: 5000` (5 seconds)

For external API calls:
- `maxRetries: 5`
- `baseDelayMs: 500`
- `maxDelayMs: 30000` (respect rate limits)

## Anti-patterns

- **No retry at all** on service-to-service calls -- fragile
- **Retry on 4xx** -- wastes resources, will never succeed
- **Retry without backoff** -- can overwhelm a recovering service
- **Retry without a cap** -- can hang indefinitely
- **Retry non-idempotent POST without checking** -- can create duplicates
- **Stacking retry layers** -- never combine an HTTP client's built-in retry with `withRetry`/`@Retry` around the same call, or attempts multiply (`maxRetries × client.limit`). See below.

## Single retry layer

Retry belongs to **exactly one** layer per call. The `ky` HTTP clients used by the
CLI ([apps/cli/src/utils/api-client.ts](../../../apps/cli/src/utils/api-client.ts)) and Portal
([apps/portal/src/lib/api-client.ts](../../../apps/portal/src/lib/api-client.ts)) set `retry: 0`
precisely so they never stack with the shared cockatiel retry.

If a call needs transient-failure retries, pick **one** layer:

- **Enable the HTTP client's own `retry`** (with its own backoff), OR
- **Wrap the call in `withRetry` / `@Retry`** from `packages/shared/src/utils/retry.ts`.

Never both — combining them compounds attempts to `maxRetries × client.limit`.

## Reference

Full API documentation: [docs/architecture/retry.md](../../docs/architecture/retry.md)
