# MCP Gateway Sidecar

MCPJungle sidecar per worker pod. Aggregates stdio and remote HTTP MCP servers behind a single streamable HTTP endpoint (`/mcp`). Enables ACP workers to use stdio servers (which require local filesystem access) alongside remote servers, with clean per-message isolation.

**POC**: `~/tmp/mcp-gateway-poc-devproxy` — validated stdio + remote HTTP + Dev Proxy HAR capture end-to-end.

---

## Traffic Flow

```
Worker process
  → MCPJungle /api/v0/* (registration)   — localhost, bypasses Dev Proxy
  → ACP session → localhost:8080/mcp     — localhost, bypasses Dev Proxy

Agent subprocess (copilot/claude-code)
  → Copilot API (HTTPS)                  — through Dev Proxy → captured in HAR
  → localhost:8080/mcp (tool calls)      — localhost, bypasses Dev Proxy

MCPJungle sidecar
  → stdio child process (/workspace)     — in-process, shared volume
  → remote HTTP (context7, etc.)         — direct outbound
```

Dev Proxy captures tool calls from the **Copilot API response body**. It never sees MCP wire traffic — that's fine, the tool names and arguments are fully captured in the LLM's response. The exact shape depends on the model's API: chat-completions models use `tool_calls[]`, while gpt-5.x uses the **Responses API** (`function_call` / `custom_tool_call` items). `extractToolCalls` (`packages/shared/src/har/har-parser.ts`) parses all supported formats — see [gates.md](../design/gates.md) §3 for the full list.

---

## Per-Message Lifecycle

```
1. Purge stale servers        GET /api/v0/servers → DELETE /api/v0/servers/{name} each
2. Resolve slugs              GET /api/v1/mcp/servers/:slug (Scope API)
3. Register servers           POST /api/v0/servers?force=true (one per server)
4. ACP session                mcpServers: [{ type: "http", url: "http://localhost:8080/mcp" }]
5. Agent runs                 tool calls go through gateway, captured in HAR via Copilot API
6. Cleanup (finally)          DELETE /api/v0/servers/{name} each
```

Step 1 is crash recovery — under normal operation step 6 cleans up. Both are needed.

---

## MCPJungle HTTP API (confirmed in POC)

| Method   | Path                         | Purpose                                   |
| -------- | ---------------------------- | ----------------------------------------- |
| `GET`    | `/health`                    | Health check (HEAD returns 404 — use GET) |
| `GET`    | `/api/v0/servers`            | List registered servers                   |
| `POST`   | `/api/v0/servers?force=true` | Register server                           |
| `DELETE` | `/api/v0/servers/{name}`     | Deregister server                         |
| `POST`   | `/mcp`                       | MCP streamable HTTP endpoint              |

Registration payload varies by transport:

```json
// stdio
{ "name": "filesystem", "transport": "stdio", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "/workspace"],
  "session_mode": "stateful" }

// remote HTTP
{ "name": "context7", "transport": "streamable_http",
  "url": "https://mcp.context7.com/mcp" }
```

Tool names are namespaced: `{server-name}__{tool-name}` (e.g. `filesystem__read_text_file`).

---

## Required Code Changes

### 1. `packages/shared/src/types/mcp.ts`

Extend transport type and `McpServerDocument` for stdio fields:

```typescript
export type McpTransportType = "sse" | "http" | "stdio";

export interface McpServerDocument {
  _id: string;
  name: string;
  type: McpTransportType;
  url?: string; // required for sse/http
  command?: string; // required for stdio
  args?: string[]; // stdio args
  env?: Record<string, string>; // stdio env vars
  headers?: McpServerHeader[]; // sse/http auth headers
  sessionMode?: "stateful" | "stateless";
  version?: string; // stdio only — npm package version
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}
```

> ⚠️ Secrets in `headers` and `env` are stored plaintext in MongoDB. Migrate to Key Vault (ESO) in a follow-up.

### 2. `packages/shared/src/mcp/mcp-gateway-client.ts` (new)

HTTP client wrapping the MCPJungle `/api/v0/` endpoints:

```typescript
export class McpGatewayClient {
  constructor(private baseUrl = "http://localhost:8080") {}
  async listServers(): Promise<string[]>; // GET /api/v0/servers → names[]
  async registerServer(doc: McpServerDocument): Promise<void>; // POST /api/v0/servers?force=true
  async deregisterServer(name: string): Promise<void>; // DELETE /api/v0/servers/{name}
  async purgeAll(): Promise<void>; // listServers → deregister each
  get mcpEndpoint(): string {
    return `${this.baseUrl}/mcp`;
  }
}
```

Transport mapping (`McpServerDocument.type` → MCPJungle `transport` field):

| DB type | MCPJungle transport |
| ------- | ------------------- |
| `http`  | `streamable_http`   |
| `sse`   | `sse`               |
| `stdio` | `stdio`             |

### 3. Worker `processMessage()` (both ACP workers)

Replace direct `mcpServers` pass-through with gateway lifecycle:

```typescript
const gateway = new McpGatewayClient();
await gateway.purgeAll();
for (const config of mcpConfigs) await gateway.registerServer(config);

try {
  result = await runACPSession(message, {
    mcpServers:
      mcpConfigs.length > 0
        ? [{ type: "http", name: "mcp-gateway", url: gateway.mcpEndpoint }]
        : [],
  });
} finally {
  for (const config of mcpConfigs) await gateway.deregisterServer(config._id);
}
```

When `mcpConfigs` is empty, pass no `mcpServers` — gateway is never touched.

### 4. `buildSubprocessEnv()` (both ACP workers)

Add `NO_PROXY` so the agent subprocess reaches the gateway directly:

```typescript
...(devProxyEnabled ? {
  NODE_OPTIONS: [..., "--use-env-proxy"],
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",   // Go binaries check lowercase
})
```

### 5. Portal — MCP server create/edit form

Add fields for stdio servers (shown/hidden based on `type` selection):

| Field         | Type                                 | When shown                    |
| ------------- | ------------------------------------ | ----------------------------- |
| `type`        | select: `http \| sse \| stdio`       | always                        |
| `url`         | text                                 | `http`, `sse`                 |
| `headers`     | key-value list                       | `http`, `sse`                 |
| `command`     | text                                 | `stdio`                       |
| `args`        | text (space-separated or JSON array) | `stdio`                       |
| `env`         | key-value list                       | `stdio`                       |
| `version`     | text                                 | `stdio`                       |
| `sessionMode` | select: `stateful \| stateless`      | always (default: `stateless`) |

### 6. API — MCP server CRUD

Update Zod schemas to validate stdio fields. `url` becomes optional (required only when type is `http`/`sse`); `command` required when type is `stdio`.

### 7. Docker Compose

Add MCPJungle sidecar service per worker profile and `NO_PROXY` env var:

```yaml
mcp-gateway-copilot:
  image: ghcr.io/mcpjungle/mcpjungle:latest-stdio
  volumes:
    - workspace_copilot:/workspace
  environment:
    SESSION_IDLE_TIMEOUT_SEC: "0"

coder-acp-copilot:
  environment:
    NO_PROXY: "...,mcp-gateway-copilot"
    MCP_GATEWAY_URL: http://mcp-gateway-copilot:8080
  depends_on:
    mcp-gateway-copilot:
      condition: service_healthy
```

Use `latest-stdio` image tag — the base image doesn't include `npx`/Node for stdio servers.

### 8. Kubernetes manifests

Add MCPJungle as a second container in each worker Deployment. Share the `workspace` emptyDir volume. No service needed (sidecar pattern — worker accesses via localhost).

---

## Key POC Findings

- MCPJungle management API is `/api/v0/` (not `/servers/` as the old design assumed)
- `SESSION_IDLE_TIMEOUT_SEC=0` disables idle timeout; `-1` is invalid
- `GET /health` works; `HEAD /health` returns 404
- `?force=true` on registration is idempotent — safe to always use
- Tool names are namespaced `{server}__{tool}` — both agent and HAR parser must handle this
- `latest-stdio` image tag required for stdio support (includes Node/npx)
- Dev Proxy captures tool calls from Copilot API responses — no changes needed to HAR capture
- `--use-env-proxy` (Node 22 built-in fetch) honours `HTTP_PROXY`/`NO_PROXY` without `undici`
