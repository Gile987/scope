# Coding Worker Requirements

> **Status:** Current as of March 2026.

This document defines the requirements that every coding agent worker must satisfy. Requirements are derived from the `WorkerProcessor` interface, the `CodingAgentQueueProcessor` orchestration layer, and the patterns established by the three existing workers (Copilot CLI, Claude Code, VS Code Web).

## Quick Reference

| # | Requirement | Required | Interface |
|---|-------------|:--------:|-----------|
| 1 | [Implement `WorkerProcessor`](#1-implement-workerprocessor) | ✅ | `WorkerProcessor` |
| 2 | [Consume messages via `processMessage`](#2-consume-messages-via-processmessage) | ✅ | `processMessage()` |
| 3 | [Return `WorkerResult`](#3-return-workerresult) | ✅ | `WorkerResult` |
| 4 | [Publish structured logs](#4-publish-structured-logs) | ✅ | `WorkerLogFn` |
| 5 | [Read credentials via Token Manager](#5-read-credentials-via-token-manager) | ✅ | `TokenManagerClient` |
| 6 | [Capture HAR files](#6-capture-har-files) | Recommended | `DevProxyClient` |
| 7 | [Capture video recordings](#7-capture-video-recordings) | Conditional | `WorkerResult.videoFilePaths` |
| 8 | [Implement lifecycle hooks](#8-implement-lifecycle-hooks) | Recommended | `setup()` / `teardown()` |
| 9 | [Report agent & component versions](#9-report-agent--component-versions) | Recommended | `getAgentVersion()` / `getComponentVersions()` |
| 10 | [Support model selection](#10-support-model-selection) | ✅ | `WorkerProcessorOptions.model` |
| 11 | [Support MCP servers](#11-support-mcp-servers) | Recommended | `WorkerProcessorOptions.mcpServerConfigs` |
| 12 | [Support Skills](#12-support-skills) | Recommended | `WorkerProcessorOptions.skillConfigs` |
| 13 | [Have integration tests](#13-have-integration-tests) | Recommended | — |
| 14 | [Support multi-turn conversations](#14-support-multi-turn-conversations) | ✅ | `setup()` + `processMessage()` × N + `teardown()` |

## Detailed Requirements

### 1. Implement `WorkerProcessor`

Every worker must export a class that implements the `WorkerProcessor` interface from `shared`:

```typescript
import { WorkerProcessor } from "shared";

class MyAgentProcessor implements WorkerProcessor {
  readonly workerName = "coder-my-agent";
  // ...
}
```

The `workerName` must be unique and match the worker's queue routing configuration.

**Source:** [`packages/shared/src/types/types.ts`](../../packages/shared/src/types/types.ts) — `WorkerProcessor` interface.

---

### 2. Consume messages via `processMessage`

The core contract. The queue processor calls `processMessage()` with the task prompt, a log function, and options. The worker must invoke its coding agent and return a `WorkerResult`.

```typescript
async processMessage(
  message: string,         // The task prompt
  log: WorkerLogFn,        // Structured logging callback
  options?: WorkerProcessorOptions
): Promise<WorkerResult>
```

For multi-turn runs, `processMessage()` is called multiple times on the same worker instance (once per iteration), with judge feedback appended to the message. The worker must support repeated invocations without re-initialization (see [lifecycle hooks](#8-implement-lifecycle-hooks)).

**Source:** [`packages/shared/src/queue/queue-processor.ts`](../../packages/shared/src/queue/queue-processor.ts) — `handleRequest()` orchestration.

---

### 3. Return `WorkerResult`

Every `processMessage()` call must return a `WorkerResult`:

```typescript
interface WorkerResult {
  response: string;           // The coding agent's text response (required)
  harFilePath?: string;       // Path to HAR file on disk (optional)
  videoFilePaths?: string[];  // Paths to video recordings on disk (optional)
  tokenUsage?: TokenUsage;    // LLM token usage counters (optional)
}
```

The queue processor handles uploading HAR and video files to Azure Blob Storage — the worker only needs to provide local file paths.

**Source:** [`packages/shared/src/types/types.ts`](../../packages/shared/src/types/types.ts) — `WorkerResult` interface.

---

### 4. Publish structured logs

All worker operations must emit logs through the provided `WorkerLogFn` callback. Logs are streamed in real time to the Portal and CLI via Redis Pub/Sub → SSE.

```typescript
type WorkerLogFn = (
  level: "info" | "warn" | "error" | "debug",
  message: string,
  data?: Record<string, unknown>
) => Promise<void>;
```

Workers should log:
- Startup and configuration (agent version, model, MCP server count, skill count)
- Token acquisition (redacted preview)
- Key state transitions (e.g., auth flow steps, agent start/stop)
- Errors and warnings with context

**Source:** [`packages/shared/src/types/types.ts`](../../packages/shared/src/types/types.ts) — `WorkerLogFn` type.

---

### 5. Read credentials via Token Manager

Workers must **not** hardcode or require credentials via environment variables at deployment time. Instead, they acquire credentials at runtime through the `TokenManagerClient`:

```typescript
import { TokenManagerClient } from "shared";

const tokenClient = new TokenManagerClient();

// Simple acquisition (returns token string)
const token = await tokenClient.acquireToken("copilot-sdk");

// Full acquisition with metadata (returns { value, tokenType, ... })
const response = await tokenClient.acquireTokenFull("claude-code-cli", "anthropic-oauth");
```

Each worker uses the appropriate **capability** for its agent:

| Worker | Capability | Token Type |
|--------|-----------|------------|
| `coder-acp-copilot` | `copilot-sdk` | GitHub PAT / OAuth |
| `coder-acp-claude-code` | `claude-code-cli` | Anthropic API key / OAuth |

The Token Manager provides round-robin distribution, automatic validation, and secure storage via Azure Key Vault.

**Source:** [`docs/architecture/token-manager.md`](token-manager.md) — Token Manager architecture.

---

### 6. Capture HAR files

Workers should capture HTTP traffic using the **DevProxy sidecar** pattern. HAR (HTTP Archive) files enable analysis of tool calls, API usage patterns, and token consumption.

```typescript
import { DevProxyClient } from "shared";

if (DevProxyClient.isEnabled()) {
  const devProxy = new DevProxyClient();
  await devProxy.waitForReady();
  await devProxy.downloadCertificate("/tmp/dev-proxy-ca.crt");
  await devProxy.startRecording();

  // ... run the agent ...

  const harFilePath = await devProxy.stopRecording();
  return { response, harFilePath };
}
```

The queue processor automatically sanitizes HAR files (strips credentials) before uploading to blob storage.

HAR files are parsed to extract `ToolCall[]` data (tool name, arguments, timestamps) for analytics.

**When required:** All CLI-based workers (Copilot, Claude Code) should support HAR capture. Browser-based workers (VS Code Web) may use alternative approaches.

**Source:** [`packages/shared/src/har/`](../../packages/shared/src/har/) — HAR parsing and sanitization.

---

### 7. Capture video recordings

Workers that drive a **non-headless UI** (browser, desktop app) must capture video recordings of the agent session. This enables visual debugging and audit trails.

```typescript
// In processMessage():
return {
  response: agentResponse,
  videoFilePaths: ["/tmp/videos/session.webm"],
};

// In setup() — for auth flow recordings:
return {
  videoFilePaths: ["/tmp/videos/setup-totp-login.webm"],
};
```

The queue processor uploads videos to blob storage at two levels:
- **Setup videos** — captured during `setup()` (e.g., TOTP login flow), stored under `{requestId}/setup/`
- **Session videos** — captured during `processMessage()`, stored under `{requestId}/`


**Source:** [`docs/architecture/vscode-web-worker.md`](vscode-web-worker.md) — VS Code Web worker design.

---

### 8. Implement lifecycle hooks

Workers should implement `setup()` and `teardown()` for resource management:

```typescript
interface WorkerProcessor {
  setup?(log: WorkerLogFn, options?: WorkerProcessorOptions): Promise<SetupResult | void>;
  teardown?(log: WorkerLogFn): Promise<void>;
}
```

- **`setup()`** — Called once before the first `processMessage()`. Use to start long-lived processes (VS Code server, browser), authenticate, prepare the workspace. May return `SetupResult` with `videoFilePaths` from the setup phase.
- **`teardown()`** — Called once after the last `processMessage()`, **even on error**. Use to stop processes, close browsers, clean up temp files.

For multi-turn runs, the lifecycle is: `setup()` → `processMessage()` × N → `teardown()`. The worker instance is reused across iterations — `setup()` and `teardown()` are called exactly once.

**Source:** [`packages/shared/src/queue/queue-processor.ts`](../../packages/shared/src/queue/queue-processor.ts) — lifecycle orchestration.

---

### 9. Report agent & component versions

Workers should report version information for traceability:

```typescript
getAgentVersion(): string {
  // Return a version prefix, e.g. "copilot-0.0.415"
  return `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;
}

getComponentVersions(): Record<string, string> {
  // Return component env vars from versions.env
  return {
    COPILOT_CLI_VERSION: process.env.COPILOT_CLI_VERSION || "unknown",
  };
}
```

The queue processor uses `getAgentVersion()` to build the `workerVersion` field stamped on each run: `{agentVersion}-{buildTime}-{gitCommit}`.

**Naming convention:** Agent version is `{agent}-{semver}` (e.g., `copilot-0.0.415`, `claude-code-acp-0.1.2-sdk-1.0.0`).

**Source:** [`packages/shared/src/types/types.ts`](../../packages/shared/src/types/types.ts) — `getAgentVersion()`, `getComponentVersions()`.

---

### 10. Support model selection

Workers must respect the `model` field from `WorkerProcessorOptions` and pass it to their coding agent:

```typescript
async processMessage(message: string, log: WorkerLogFn, options?: WorkerProcessorOptions) {
  const model = options?.model;  // e.g. "gpt-4.1", "claude-sonnet-4"
  // Pass to agent configuration
}
```

The available models are registered in `CodingAgentDocument.supportedModels` and validated at submission time by the API.

---

### 11. Support MCP servers

Workers should pass resolved MCP server configurations to the coding agent when present:

```typescript
const mcpConfigs = options?.mcpServerConfigs ?? [];
// Pass to agent as MCP server config (format varies by agent)
```

MCP servers are resolved by the queue processor before `processMessage()` is called. The worker receives fully resolved `McpServerConfig[]` objects with name, type, URL, headers, and arguments.

**Source:** [`packages/shared/src/types/mcp.ts`](../../packages/shared/src/types/mcp.ts) — MCP types.

---

### 12. Support Skills

Skill archives are extracted to the workspace filesystem by the queue processor before `processMessage()` is called. Workers don't need to handle skill extraction — agents discover skills natively from well-known directories:

```
/workspace/.agents/skills/<skillName>/SKILL.md   # Universal
/workspace/.copilot/skills/<skillName>/SKILL.md  # Copilot-specific
/workspace/.claude/skills/<skillName>/SKILL.md   # Claude-specific
```

Workers should log the skill count for traceability:

```typescript
await log("info", "Starting processor", {
  skillCount: skillConfigs.length,
  skills: skillConfigs.map(s => s.name),
});
```

**Source:** [`docs/architecture/skills.md`](skills.md) — Skills architecture.

---

### 13. Have integration tests

Workers should have integration tests that exercise the full flow: setup → processMessage → teardown with real (or simulated) agent interactions.

**Recommended patterns:**
- **Docker-based tests** — Build the worker image, run in a container with bind mounts for artifacts
- **Credential injection** — Use `.env` files with test account credentials
- **Artifact capture** — Bind mount directories for videos, snapshots, HAR files
- **Multi-prompt flow** — Test at least two sequential prompts to verify auth reuse and session continuity

- Two-prompt sequential test: fresh auth + session reuse
- ARIA snapshots at every state transition for AI-assisted debugging
- Video recordings for visual audit

**Source:** [`docs/architecture/vscode-web-worker.md`](vscode-web-worker.md) — Integration test architecture.

---

### 14. Support multi-turn conversations

The queue processor calls `processMessage()` multiple times when criteria are present (multi-turn mode). Workers must:

1. Maintain state across calls (via `setup()` / `teardown()` lifecycle)
2. Accept feedback-augmented prompts on subsequent calls
3. Return fresh `WorkerResult` for each iteration (including per-turn HAR and video if available)

The multi-turn loop is: `setup()` → (`processMessage()` → judge → feedback) × N → `teardown()`.

**Source:** [`packages/shared/src/queue/queue-processor.ts`](../../packages/shared/src/queue/queue-processor.ts) — `processMultiTurn()`.

---

## Worker Bootstrapping

Every worker's entry point follows the same pattern:

```typescript
import { CodingAgentQueueProcessor, QueueProcessorConfig } from "shared";

const processor = new MyAgentProcessor();

const config: QueueProcessorConfig = {
  mongoUri: process.env.MONGODB_URI!,
  mongoDatabase: process.env.MONGODB_DATABASE || "scope-mt",
  mongoCollection: process.env.MONGODB_COLLECTION || "requests",
  storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
  storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  queueName: process.env.QUEUE_NAME!,
  batchSize: parseInt(process.env.BATCH_SIZE || "1"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000"),
  redisHost: process.env.REDIS_HOST!,
  redisPort: parseInt(process.env.REDIS_PORT || "6380"),
  redisPassword: process.env.REDIS_PASSWORD!,
  apiBaseUrl: process.env.SCOPE_MT_API_URL,
};

const queueProcessor = new CodingAgentQueueProcessor(config, processor);
queueProcessor.start();
```

The `CodingAgentQueueProcessor` handles all queue polling, message visibility, MongoDB persistence, blob storage uploads, HAR sanitization, video uploads, MCP/skill resolution, multi-turn orchestration, and report triggering. The worker only implements the `WorkerProcessor` interface.

## Existing Workers — Compliance Matrix

| # | Requirement | Copilot CLI | Claude Code | VS Code Web |
|---|-------------|:-----------:|:-----------:|:-----------:|
| 1 | Implement `WorkerProcessor` | ✅ | ✅ | ✅ |
| 2 | Consume messages via `processMessage` | ✅ | ✅ | ✅ |
| 3 | Return `WorkerResult` | ✅ | ✅ | ✅ |
| 4 | Publish structured logs | ✅ | ✅ | ✅ |
| 6 | Capture HAR files | ✅ DevProxy sidecar | ✅ DevProxy sidecar | ❌ Not implemented |
| 7 | Capture video recordings | N/A (CLI, headless) | N/A (CLI, headless) | ✅ Playwright recording (setup + session) |
| 8 | Implement lifecycle hooks (`setup`/`teardown`) | ❌ Not implemented | ❌ Not implemented | ✅ VS Code process + browser lifecycle |
| 9 | Report agent & component versions | ✅ `COPILOT_CLI_VERSION` | ✅ `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` |
| 10 | Support model selection | ✅ `--model` flag | ✅ `ANTHROPIC_MODEL` env | ❌ Not implemented |
| 11 | Support MCP servers | ✅ Via ACP `mcpServers` | ✅ Via ACP `mcpServers` | ❌ Not implemented |
| 12 | Support Skills | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery |
| 13 | Have integration tests | ✅ `copilot-cli.integration.test.ts` | ❌ Unit tests only | ✅ `vscode-web.integration.test.ts` (Docker) |
| 14 | Support multi-turn conversations | ✅ Via queue processor | ✅ Via queue processor | ✅ Via `setup`/`teardown` + session reuse |
| — | Token usage reporting | ✅ Extracted from HAR | ✅ Extracted from HAR | ❌ Not implemented |

### Worker Details

| Property | Copilot CLI | Claude Code | VS Code Web |
|----------|-------------|-------------|-------------|
| **Agent interface** | ACP (subprocess) | ACP (subprocess) | Playwright (browser automation) |
| **Token types** | GitHub PAT / OAuth | Anthropic API key / OAuth | GitHub OAuth cookie state |
| **Agent version format** | `copilot-{COPILOT_CLI_VERSION}` | `claude-code-acp-{ACP_VERSION}-sdk-{SDK_VERSION}` | `vscode-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` |
| **Unit tests** | ✅ `subprocess-env.test.ts` | ✅ `acp-client.test.ts` | ✅ `chat-machine.test.ts` (618 tests), `chat-actions.test.ts`, `index.test.ts` |
| **Integration tests** | ✅ `copilot-cli.integration.test.ts` | ❌ | ✅ `vscode-web.integration.test.ts` (Docker-based, two-prompt flow) |

## Key Files

| File | Purpose |
|------|---------|
| [`packages/shared/src/types/types.ts`](../../packages/shared/src/types/types.ts) | `WorkerProcessor`, `WorkerResult`, `SetupResult`, `WorkerProcessorOptions` |
| [`packages/shared/src/queue/queue-processor.ts`](../../packages/shared/src/queue/queue-processor.ts) | `CodingAgentQueueProcessor` — lifecycle orchestration |
| [`packages/shared/src/queue/base-queue-processor.ts`](../../packages/shared/src/queue/base-queue-processor.ts) | `BaseQueueProcessor` — queue polling, message handling |
| [`packages/shared/src/har/har-parser.ts`](../../packages/shared/src/har/har-parser.ts) | HAR sanitization and tool call extraction |
| [`packages/shared/src/storage/blob-storage.ts`](../../packages/shared/src/storage/blob-storage.ts) | Azure Blob Storage upload client |
| [`docs/architecture/token-manager.md`](token-manager.md) | Token Manager architecture |
| [`docs/architecture/skills.md`](skills.md) | Skills delivery architecture |
| [`docs/architecture/vscode-web-worker.md`](vscode-web-worker.md) | VS Code Web worker reference implementation |
