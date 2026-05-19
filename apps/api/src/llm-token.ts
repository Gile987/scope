// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared helper for acquiring an inference client for the portal AI features.
 *
 * Endpoint resolution priority:
 *   1. Azure AI Foundry env vars — AZURE_AI_INFERENCE_ENDPOINT +
 *      AZURE_AI_INFERENCE_API_KEY (preferred for local dev; explicit override).
 *   2. Azure AI Foundry via the Token Manager — TOKEN_MANAGER_URL with at
 *      least one registered `azure-ai-foundry` key (preferred for prod;
 *      round-robins across registered keys).
 *   3. GitHub Models — https://models.inference.ai.azure.com via
 *      GITHUB_MODELS_API_KEY → TokenManagerClient("github-models") → GITHUB_TOKEN
 *      (fallback; slow public endpoint, fine for local dev only).
 *
 * All three portal LLM modules (llm.ts, prompt-feature-llm.ts,
 * task-prompt-llm.ts) call acquireInferenceClient() instead of constructing
 * a ModelClient inline so the endpoint can be swapped in one place.
 */
import ModelClient, { type ModelClient as ModelClientType } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { TokenManagerClient, parseAzureAiFoundrySecret } from "shared";

const GITHUB_MODELS_ENDPOINT = "https://models.inference.ai.azure.com";

let tokenManagerClient: TokenManagerClient | null = null;

function getTokenManagerClient(): TokenManagerClient | null {
  if (tokenManagerClient) return tokenManagerClient;
  const url = process.env.TOKEN_MANAGER_URL;
  if (!url) return null;
  tokenManagerClient = new TokenManagerClient(url);
  return tokenManagerClient;
}

function isFoundryConfigured(): boolean {
  return !!(process.env.AZURE_AI_INFERENCE_ENDPOINT && process.env.AZURE_AI_INFERENCE_API_KEY);
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
 * Returns true if any inference backend (Foundry or GitHub Models) is configured.
 */
export function isLlmAvailable(): boolean {
  return isFoundryConfigured() || isGitHubModelsTokenAvailable();
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

export type InferenceSource = "azure-ai-foundry" | "github-models";

export interface InferenceClientHandle {
  client: ModelClientType;
  endpoint: string;
  source: InferenceSource;
  /**
   * When the source is "azure-ai-foundry" via the Token Manager, the
   * registered secret can override the default model name. Callers should
   * honour this when present (and fall back to `process.env.LLM_MODEL`).
   */
  model?: string;
}

/**
 * Try to acquire a Foundry credential from the Token Manager.
 *
 * Bypasses TokenManagerClient.acquireToken's env-var shortcut on purpose:
 * the env-var fallback only carries the API key, not the endpoint+key+model
 * JSON blob this code path needs.
 *
 * Returns null when no token-manager is configured, when no key is
 * registered for the capability, or when the registered secret is malformed.
 */
async function tryAcquireFoundryFromTokenManager(): Promise<{
  endpoint: string;
  apiKey: string;
  model?: string;
} | null> {
  const baseUrl = process.env.TOKEN_MANAGER_URL;
  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/api/v1/keys/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "azure-ai-inference" }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      // No keys registered for this capability — fall through to next backend
      return null;
    }
    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as { value?: string };
    if (!result.value) return null;

    return parseAzureAiFoundrySecret(result.value);
  } catch {
    return null;
  }
}

/**
 * Build a ModelClient for the configured inference backend.
 *
 * Tries Azure AI Foundry first (env vars, then Token Manager), then falls
 * back to GitHub Models. See module docstring for the full priority order.
 *
 * @throws Error if no inference backend is configured.
 */
export async function acquireInferenceClient(): Promise<InferenceClientHandle> {
  // 1. Azure AI Foundry via env vars — explicit override, preferred locally.
  if (isFoundryConfigured()) {
    const endpoint = process.env.AZURE_AI_INFERENCE_ENDPOINT!;
    const apiKey = process.env.AZURE_AI_INFERENCE_API_KEY!;
    return {
      client: ModelClient(endpoint, new AzureKeyCredential(apiKey)),
      endpoint,
      source: "azure-ai-foundry",
    };
  }

  // 2. Azure AI Foundry via the Token Manager — preferred in production.
  const tmFoundry = await tryAcquireFoundryFromTokenManager();
  if (tmFoundry) {
    return {
      client: ModelClient(tmFoundry.endpoint, new AzureKeyCredential(tmFoundry.apiKey)),
      endpoint: tmFoundry.endpoint,
      source: "azure-ai-foundry",
      model: tmFoundry.model,
    };
  }

  // 3. GitHub Models — public fallback (slow; fine for local dev).
  if (isGitHubModelsTokenAvailable()) {
    const token = await acquireGitHubModelsToken();
    return {
      client: ModelClient(GITHUB_MODELS_ENDPOINT, new AzureKeyCredential(token)),
      endpoint: GITHUB_MODELS_ENDPOINT,
      source: "github-models",
    };
  }

  throw new Error(
    "No inference backend configured: set AZURE_AI_INFERENCE_ENDPOINT + AZURE_AI_INFERENCE_API_KEY (preferred), register an `azure-ai-foundry` key in the Token Manager, or fall back to GITHUB_MODELS_API_KEY / GITHUB_TOKEN / TOKEN_MANAGER_URL"
  );
}
