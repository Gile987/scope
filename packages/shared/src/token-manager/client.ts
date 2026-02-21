// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AcquireTokenResponse,
  TOKEN_CAPABILITY_ENV_VARS,
  TokenCapability,
} from "./types.js";

/**
 * Client for acquiring tokens from the Token Manager service.
 *
 * Workers use this to get a token before each coding session.
 * If the corresponding env var is set (e.g. GITHUB_TOKEN for 'copilot-sdk'),
 * the env var value is returned directly — no HTTP call is made.
 * This allows Docker Compose / local dev to work without the Token Manager.
 */
export class TokenManagerClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (
      baseUrl ||
      process.env.TOKEN_MANAGER_URL ||
      ""
    ).replace(/\/+$/, "");
  }

  /**
   * Acquire a token for the given capability.
   *
   * 1. If the env var fallback is set (e.g. GITHUB_TOKEN), return it directly.
   * 2. Otherwise, call `POST {baseUrl}/api/v1/tokens/acquire` with `{ capability }`.
   *
   * @throws Error if no token is available or the request fails.
   */
  async acquireToken(capability: TokenCapability): Promise<string> {
    // Env var fallback — local dev / Docker Compose
    const envVar = TOKEN_CAPABILITY_ENV_VARS[capability];
    const envValue = process.env[envVar];
    if (envValue) {
      return envValue;
    }

    if (!this.baseUrl) {
      throw new Error(
        `No token available for capability '${capability}': ` +
          `env var '${envVar}' is not set and TOKEN_MANAGER_URL is not configured`
      );
    }

    const url = `${this.baseUrl}/api/v1/tokens/acquire`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Token acquisition failed for capability '${capability}' (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as AcquireTokenResponse;

    if (!result.value) {
      throw new Error(
        `Invalid token response for capability '${capability}': no value returned`
      );
    }

    return result.value;
  }
}
