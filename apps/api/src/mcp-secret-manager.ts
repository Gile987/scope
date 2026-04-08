// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import type { McpServerHeader } from "shared";

const MASKED = "<secret>";

/** Returns true if Key Vault is configured (AZURE_KEYVAULT_URI is set) */
export function isKvEnabled(): boolean {
  return !!process.env.AZURE_KEYVAULT_URI;
}

/** KV secret name for an env var on a given server */
function envSecretName(serverId: string, key: string): string {
  // KV names: 1-127 chars, alphanumeric + hyphens. Replace _ with - and sanitise.
  const safeKey = key.replace(/_/g, "-").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
  return `mcp-${serverId}-env-${safeKey}`;
}

/** KV secret name for a header at a given index */
function headerSecretName(serverId: string, index: number): string {
  return `mcp-${serverId}-hdr-${index}`;
}

/** KV reference sentinel stored in MongoDB */
function kvRef(name: string): string {
  return `@kv:${name}`;
}

/** Returns true if the value is a KV reference */
function isKvRef(value: string): boolean {
  return value.startsWith("@kv:");
}

/** Extracts the KV secret name from a reference string */
function kvRefName(ref: string): string {
  return ref.slice(4);
}

/**
 * Manages Azure Key Vault storage for MCP server secrets (env vars + headers).
 *
 * Secrets are stored under predictable names:
 *   - env:    `mcp-{serverId}-env-{KEY}`
 *   - header: `mcp-{serverId}-hdr-{index}`
 *
 * MongoDB stores `@kv:<name>` references in place of plaintext values.
 * The `mask()` helper replaces references with `"<secret>"` for API responses.
 * The `resolve()` helper replaces references with actual values for workers.
 */
export class McpSecretManager {
  private client: SecretClient;

  constructor(vaultUri?: string) {
    const uri = vaultUri ?? process.env.AZURE_KEYVAULT_URI!;
    this.client = new SecretClient(uri, new DefaultAzureCredential(), {
      disableChallengeResourceVerification: true,
    });
  }

  // ─── Write helpers ─────────────────────────────────────────────────────────

  /**
   * Store env vars in KV; return a new env map where values are `@kv:` refs.
   * Values that already look like `@kv:` refs are left unchanged (idempotent PUT).
   */
  async storeEnv(
    serverId: string,
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (isKvRef(value)) {
        result[key] = value; // already a ref — keep as-is
        continue;
      }
      const name = envSecretName(serverId, key);
      await this.client.setSecret(name, value);
      result[key] = kvRef(name);
    }
    return result;
  }

  /**
   * Store header values in KV; return new headers array with values replaced by refs.
   * Existing `@kv:` refs are kept unchanged.
   */
  async storeHeaders(
    serverId: string,
    headers: McpServerHeader[],
    startIndex = 0,
  ): Promise<McpServerHeader[]> {
    const result: McpServerHeader[] = [];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (isKvRef(h.value)) {
        result.push(h);
        continue;
      }
      const name = headerSecretName(serverId, startIndex + i);
      await this.client.setSecret(name, h.value);
      result.push({ name: h.name, value: kvRef(name) });
    }
    return result;
  }

  // ─── Delete helpers ────────────────────────────────────────────────────────

  /** Best-effort: delete all KV secrets for a server. Logs but never throws. */
  async deleteAll(
    serverId: string,
    env?: Record<string, string>,
    headers?: McpServerHeader[],
  ): Promise<void> {
    const names: string[] = [];

    if (env) {
      for (const key of Object.keys(env)) {
        names.push(envSecretName(serverId, key));
      }
    }
    if (headers) {
      for (let i = 0; i < headers.length; i++) {
        names.push(headerSecretName(serverId, i));
      }
    }

    for (const name of names) {
      try {
        await this.client.beginDeleteSecret(name);
      } catch (err) {
        // Best-effort: 404 means already gone, other errors are logged
        const status = (err as any)?.statusCode;
        if (status !== 404) {
          console.warn(`[McpSecretManager] Failed to delete KV secret '${name}': ${err}`);
        }
      }
    }
  }

  // ─── Read helpers ──────────────────────────────────────────────────────────

  /**
   * Replace `@kv:` refs with actual values fetched from KV.
   * Throws if any secret cannot be resolved.
   */
  async resolveEnv(env: Record<string, string>): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (isKvRef(value)) {
        const name = kvRefName(value);
        const secret = await this.client.getSecret(name);
        if (!secret.value) throw new Error(`KV secret '${name}' has no value`);
        result[key] = secret.value;
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  async resolveHeaders(headers: McpServerHeader[]): Promise<McpServerHeader[]> {
    const result: McpServerHeader[] = [];
    for (const h of headers) {
      if (isKvRef(h.value)) {
        const name = kvRefName(h.value);
        const secret = await this.client.getSecret(name);
        if (!secret.value) throw new Error(`KV secret '${name}' has no value`);
        result.push({ name: h.name, value: secret.value });
      } else {
        result.push(h);
      }
    }
    return result;
  }
}

// ─── Pure mask helpers (no KV required) ────────────────────────────────────

/** Replace `@kv:` refs in an env map with `"<secret>"` for API responses */
export function maskEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = isKvRef(value) ? MASKED : value;
  }
  return result;
}

/** Replace `@kv:` header values with `"<secret>"` for API responses */
export function maskHeaders(headers: McpServerHeader[]): McpServerHeader[] {
  return headers.map((h) => ({
    name: h.name,
    value: isKvRef(h.value) ? MASKED : h.value,
  }));
}
