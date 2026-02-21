// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared helper for acquiring a GitHub Models API token.
 *
 * Priority:
 *   1. GITHUB_MODELS_API_KEY env var (explicit override)
 *   2. TokenManagerClient acquire("github-models") via TOKEN_MANAGER_URL
 *   3. GITHUB_TOKEN env var (generic fallback used by TokenManagerClient)
 *
 * Both llm.ts and prompt-feature-llm.ts use this module instead of
 * reading env vars directly.
 */
import { TokenManagerClient } from "shared";

let tokenManagerClient: TokenManagerClient | null = null;

function getTokenManagerClient(): TokenManagerClient | null {
  if (tokenManagerClient) return tokenManagerClient;
  const url = process.env.TOKEN_MANAGER_URL;
  if (!url) return null;
  tokenManagerClient = new TokenManagerClient(url);
  return tokenManagerClient;
}

/**
 * Returns true if a GitHub Models token is available from any source:
 * - GITHUB_MODELS_API_KEY env var
 * - TOKEN_MANAGER_URL (token manager with registered github-models tokens)
 * - GITHUB_TOKEN env var (generic fallback)
 */
export function isGitHubModelsTokenAvailable(): boolean {
  return !!(
    process.env.GITHUB_MODELS_API_KEY ||
    process.env.TOKEN_MANAGER_URL ||
    process.env.GITHUB_TOKEN
  );
}

/**
 * Acquire a GitHub Models API token.
 *
 * @throws Error if no token source is available.
 */
export async function acquireGitHubModelsToken(): Promise<string> {
  // 1. Explicit env var override
  const explicit = process.env.GITHUB_MODELS_API_KEY;
  if (explicit) return explicit;

  // 2. Token Manager (handles its own GITHUB_TOKEN fallback internally)
  const client = getTokenManagerClient();
  if (client) {
    return client.acquireToken("github-models");
  }

  // 3. Bare GITHUB_TOKEN fallback (no token manager)
  const fallback = process.env.GITHUB_TOKEN;
  if (fallback) return fallback;

  throw new Error(
    "No GitHub Models token available: set GITHUB_MODELS_API_KEY, GITHUB_TOKEN, or configure TOKEN_MANAGER_URL"
  );
}
