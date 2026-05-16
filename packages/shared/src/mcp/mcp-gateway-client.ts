// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig } from '../types/mcp.js';
import { withRetry } from '../utils/retry.js';

/** Maps DB transport type to MCPJungle transport name */
const TRANSPORT_MAP: Record<string, string> = {
  http: 'streamable_http',
  sse: 'sse',
  stdio: 'stdio',
};

/** Default timeout (ms) for waitForHealthy — gateway typically starts in ~20s on cold image pull */
const DEFAULT_HEALTHY_TIMEOUT_MS = 60_000;
/** Polling interval (ms) for waitForHealthy */
const DEFAULT_HEALTHY_POLL_MS = 1_000;

/** Retry defaults for transient network errors */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

/**
 * Returns true if the error is a transient network-level failure
 * (ECONNREFUSED, fetch failed, ETIMEDOUT, etc.) that is worth retrying.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  // Check the cause chain for ECONNREFUSED (Node wraps it in AggregateError)
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause ? (cause as { code?: string }).code : undefined;
  return (
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('UND_ERR_CONNECT_TIMEOUT') ||
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ETIMEDOUT' ||
    causeCode === 'ECONNRESET'
  );
}

/**
 * HTTP client for the MCPJungle gateway sidecar.
 *
 * MCPJungle aggregates stdio and remote HTTP MCP servers behind a single
 * streamable HTTP endpoint. Workers register servers per-message and route
 * all MCP traffic through the gateway endpoint.
 *
 * Reads MCP_GATEWAY_URL from env. Use McpGatewayClient.isEnabled() to check
 * if the gateway sidecar is configured before creating an instance.
 */
export class McpGatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.MCP_GATEWAY_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  }

  /** The streamable HTTP endpoint to pass to ACP sessions */
  get mcpEndpoint(): string {
    return `${this.baseUrl}/mcp`;
  }

  /** Returns true if MCP_GATEWAY_URL is set in the environment */
  static isEnabled(): boolean {
    return !!process.env.MCP_GATEWAY_URL;
  }

  /**
   * Poll GET /health until the gateway returns 200 or the timeout expires.
   * Uses the same endpoint as the K8S readiness probe.
   *
   * @param options.timeoutMs  - Max time to wait (default: 60 000ms)
   * @param options.pollMs     - Polling interval (default: 1 000ms)
   * @param options.log        - Optional log callback for progress messages
   */
  async waitForHealthy(options?: {
    timeoutMs?: number;
    pollMs?: number;
    log?: (msg: string) => void;
  }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HEALTHY_TIMEOUT_MS;
    const pollMs = options?.pollMs ?? DEFAULT_HEALTHY_POLL_MS;
    const log = options?.log ?? (() => {});
    const deadline = Date.now() + timeoutMs;

    log(`[McpGatewayClient] Waiting for gateway to become healthy at ${this.baseUrl}/health (timeout=${timeoutMs}ms)...`);

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health`);
        if (res.ok) {
          log(`[McpGatewayClient] Gateway is healthy`);
          return;
        }
      } catch {
        // Gateway not reachable yet — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(
      `[McpGatewayClient] Gateway did not become healthy within ${timeoutMs}ms at ${this.baseUrl}/health`
    );
  }

  /** List currently registered server names (retries on transient network errors) */
  async listServers(): Promise<string[]> {
    return withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/v0/servers`);
      if (!res.ok) {
        throw new Error(`[McpGatewayClient] GET /api/v0/servers failed: ${res.status}`);
      }
      const data = await res.json() as Array<{ name: string }>;
      return data.map((s) => s.name);
    }, {
      maxRetries: RETRY_MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      isRetryable: isTransientNetworkError,
    });
  }

  /** Register a server with the gateway (force=true is idempotent, retries on transient errors) */
  async registerServer(config: McpServerConfig): Promise<void> {
    const transport = TRANSPORT_MAP[config.type] ?? config.type;
    // Use slug (gateway-safe identifier) as the name — display name may contain spaces
    const body: Record<string, unknown> = { name: config.slug, transport };

    if (config.type === 'stdio') {
      body.command = config.command;
      body.args = config.args ?? [];
      if (config.env && Object.keys(config.env).length > 0) body.env = config.env;
      body.session_mode = config.sessionMode ?? 'stateful';
    } else {
      body.url = config.url;
      body.session_mode = config.sessionMode ?? 'stateless';
      if (config.headers && config.headers.length > 0) {
        body.headers = Object.fromEntries(config.headers.map((h) => [h.name, h.value]));
      }
    }

    return withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/v0/servers?force=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`[McpGatewayClient] POST /api/v0/servers failed: ${res.status} ${text}`);
      }
    }, {
      maxRetries: RETRY_MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      isRetryable: isTransientNetworkError,
    });
  }

  /** Deregister a server by name (404 is treated as success, retries on transient errors) */
  async deregisterServer(name: string): Promise<void> {
    return withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/v0/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`[McpGatewayClient] DELETE /api/v0/servers/${name} failed: ${res.status}`);
      }
    }, {
      maxRetries: RETRY_MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      isRetryable: isTransientNetworkError,
    });
  }

  /** Deregister all currently registered servers (crash recovery) */
  async purgeAll(): Promise<void> {
    const names = await this.listServers();
    await Promise.all(names.map((name) => this.deregisterServer(name)));
  }
}
