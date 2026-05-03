// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * GatewayClient — talks to the Rust TLS-intercepting gateway proxy.
 *
 * Uses the RESTful session API:
 *   POST   /api/v1/sessions           → create session (returns { id })
 *   GET    /api/v1/sessions           → list sessions
 *   GET    /api/v1/sessions/:id       → session status
 *   POST   /api/v1/sessions/:id/stop  → stop recording
 *   GET    /api/v1/sessions/:id/har   → download HAR
 *   DELETE /api/v1/sessions/:id       → delete session
 *   GET    /api/v1/cacert             → CA certificate
 *   GET    /health                   → health check
 */

import type { HarFile } from "../har/types.js";
import { withRetry } from "../utils/retry.js";
import {
  waitForProxyReady,
  downloadProxyCertificate,
  createCombinedCaBundle,
} from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18000";

export class GatewayClient {
  readonly apiUrl: string;
  private sessionId: string | null = null;

  constructor(
    apiUrl: string = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL,
  ) {
    this.apiUrl = apiUrl;
  }

  /** The MCP endpoint URL for MCP-aware workers. */
  get mcpEndpoint(): string {
    return `${this.apiUrl}/mcp`;
  }

  /**
   * Proxy URL with the session ID embedded in the userinfo field.
   * HTTP clients will send this as a `Proxy-Authorization: Basic` header,
   * allowing the gateway to resolve the session directly without IP lookup.
   *
   * Returns the bare apiUrl if no session has been started yet.
   */
  get proxyUrl(): string {
    if (!this.sessionId) {
      return this.apiUrl;
    }
    const url = new URL(this.apiUrl);
    url.username = this.sessionId;
    return url.toString().replace(/\/$/, "");
  }

  async waitForReady(timeoutMs?: number): Promise<void> {
    return waitForProxyReady(this.apiUrl, timeoutMs);
  }

  async downloadCertificate(outputPath: string): Promise<void> {
    return downloadProxyCertificate(this.apiUrl, outputPath);
  }

  async createCombinedCaBundle(proxyCertPath: string, outputPath: string): Promise<string> {
    return createCombinedCaBundle(proxyCertPath, outputPath);
  }

  async startSession(plugins: Record<string, unknown> = {}): Promise<string> {
    const id = this.sessionId ?? crypto.randomUUID();
    const response = await fetch(`${this.apiUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, plugins }),
    });
    if (!response.ok) {
      throw new Error(`Failed to create gateway session: ${response.status} ${response.statusText}`);
    }
    this.sessionId = id;
    return id;
  }

  async stopSession(): Promise<void> {
    const id = this.requireSessionId();
    const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}/stop`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Failed to stop gateway session: ${response.status} ${response.statusText}`);
    }
  }

  async downloadHar(iteration: number): Promise<HarFile | null> {
    const id = this.sessionId;
    if (!id) return null;
    try {
      return await withRetry(
        async () => {
          const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}/har?iteration=${iteration}`);
          if (!response.ok) {
            throw new Error(`HAR download failed: ${response.status} ${response.statusText}`);
          }
          return (await response.json()) as HarFile;
        },
        {
          maxRetries: 3,
          baseDelayMs: 500,
          isRetryable: () => true,
          onRetry: (err, attempt) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[GatewayClient] HAR download attempt ${attempt} failed: ${msg}`);
          },
        },
      );
    } catch {
      return null;
    }
  }

  /**
   * Rotate the HAR iteration: CAS-guarded bump from `expected` to `expected+1`.
   * Returns the new iteration number on success.
   * Throws on 409 (iteration mismatch) or other errors.
   */
  async rotateHar(expected: number): Promise<number> {
    const id = this.requireSessionId();
    const response = await fetch(
      `${this.apiUrl}/api/v1/sessions/${id}/har/rotate?expected=${expected}`,
      { method: "POST" },
    );
    const body = (await response.json()) as { iteration: number };
    if (response.status === 409) {
      throw new Error(
        `HAR rotate conflict: expected iteration ${expected}, server has ${body.iteration}`,
      );
    }
    if (!response.ok) {
      throw new Error(`HAR rotate failed: ${response.status} ${response.statusText}`);
    }
    return body.iteration;
  }

  async deleteSession(): Promise<void> {
    const id = this.requireSessionId();
    const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete gateway session: ${response.status} ${response.statusText}`);
    }
    this.sessionId = null;
  }

  /** Returns the current session ID, or throws if no session has been started. */
  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("No active gateway session — call startSession() first");
    }
    return this.sessionId;
  }
}
