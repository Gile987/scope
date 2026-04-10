// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpEnvVarDocument } from '../types/mcp.js';

/** Request body for creating an MCP env var */
export interface CreateMcpEnvVarRequest {
  key: string;
  value: string;
}

/** Response from listing env vars (keys only — values never returned) */
export interface McpEnvVarListItem {
  id: string;
  mcpName: string;
  key: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Client for managing MCP server env var secrets via the Token Manager service.
 *
 * Secrets are stored encrypted in Azure Key Vault by the Token Manager.
 * The API uses this client to store/resolve/delete env vars at CRUD time.
 * Workers call resolveEnv() at task-processing time to get actual values.
 */
export class McpEnvVarClient {
  private readonly tokenManagerUrl: string;

  constructor(tokenManagerUrl: string) {
    this.tokenManagerUrl = tokenManagerUrl.replace(/\/+$/, '');
  }

  /**
   * Store all env vars for an MCP server.
   * Returns the list of created/updated documents (keys only, no values).
   */
  async storeEnv(
    mcpName: string,
    env: Record<string, string>,
  ): Promise<McpEnvVarListItem[]> {
    const results: McpEnvVarListItem[] = [];
    for (const [key, value] of Object.entries(env)) {
      const url = `${this.tokenManagerUrl}/mcp/servers/${encodeURIComponent(mcpName)}/env-vars`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value } satisfies CreateMcpEnvVarRequest),
      });
      if (!res.ok) {
        throw new Error(`[McpEnvVarClient] POST ${url} failed: ${res.status} ${res.statusText}`);
      }
      results.push(await res.json() as McpEnvVarListItem);
    }
    return results;
  }

  /**
   * List all env var metadata (keys, ids — no values) for an MCP server.
   */
  async listEnv(mcpName: string): Promise<McpEnvVarListItem[]> {
    const url = `${this.tokenManagerUrl}/mcp/servers/${encodeURIComponent(mcpName)}/env-vars`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[McpEnvVarClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<McpEnvVarListItem[]>;
  }

  /**
   * Resolve all env vars for an MCP server to their actual plaintext values.
   * Used by workers at task-processing time via ?resolve=true.
   */
  async resolveEnv(mcpName: string): Promise<Record<string, string>> {
    const url = `${this.tokenManagerUrl}/mcp/servers/${encodeURIComponent(mcpName)}/env-vars?resolve=true`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[McpEnvVarClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<Record<string, string>>;
  }

  /**
   * Delete a single env var by id.
   */
  async deleteEnvVar(mcpName: string, id: string): Promise<void> {
    const url = `${this.tokenManagerUrl}/mcp/servers/${encodeURIComponent(mcpName)}/env-vars/${encodeURIComponent(id)}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`[McpEnvVarClient] DELETE ${url} failed: ${res.status} ${res.statusText}`);
    }
  }

  /**
   * Delete all env vars for an MCP server (best-effort, on server delete).
   */
  async deleteAllEnvVars(mcpName: string): Promise<void> {
    const items = await this.listEnv(mcpName).catch(() => [] as McpEnvVarListItem[]);
    await Promise.allSettled(items.map((item) => this.deleteEnvVar(mcpName, item.id)));
  }
}
