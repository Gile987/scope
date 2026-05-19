// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { KeyType, KeyValidationResult, deriveCapabilities, parseAzureAiFoundrySecret } from "shared";

/**
 * Validate a key by calling the provider's API and derive its capabilities.
 * Returns a result object — never throws.
 */
export async function validateToken(
  type: KeyType,
  value: string
): Promise<KeyValidationResult> {
  let result: KeyValidationResult;

  switch (type) {
    case "github-pat-classic":
      result = await validateGitHubToken(value);
      break;
    case "github-pat-fine-grained":
      result = await validateGitHubFineGrainedPat(value);
      break;
    case "github-oauth":
      result = await validateGitHubToken(value);
      break;
    case "anthropic-api-key":
      result = await validateAnthropicKey(value);
      break;
    case "anthropic-oauth":
      result = await validateAnthropicOAuth(value);
      break;
    case "github-oauth-cookie-state":
      result = await validateGitHubOAuthCookieState(value);
      break;
    case "azure-ai-foundry":
      result = await validateAzureAiFoundry(value);
      break;
    default:
      return { status: "error", error: `Unknown token type: ${type}` };
  }

  // Derive capabilities from validation result
  result.capabilities = deriveCapabilities(type, result);
  return result;
}

/**
 * Validate a GitHub token (classic PAT or OAuth) via the /user endpoint.
 * Extracts scopes from x-oauth-scopes header.
 */
async function validateGitHubToken(
  token: string
): Promise<KeyValidationResult> {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });

    // Parse rate limit headers
    const rateLimit = parseRateLimit(response.headers);

    if (response.status === 401) {
      return { status: "invalid", error: "Authentication failed", rateLimit };
    }

    if (!response.ok) {
      return {
        status: "error",
        error: `GitHub API returned ${response.status}`,
        rateLimit,
      };
    }

    // Parse scopes
    const scopesHeader = response.headers.get("x-oauth-scopes");
    const scopes = scopesHeader
      ? scopesHeader.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    return { status: "valid", scopes, rateLimit };
  } catch (err) {
    return {
      status: "error",
      error: `GitHub token validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate a fine-grained PAT: first check /user, then probe GitHub Models API
 * to detect models:read permission.
 */
async function validateGitHubFineGrainedPat(
  token: string
): Promise<KeyValidationResult> {
  // First validate the token itself
  const baseResult = await validateGitHubToken(token);
  if (baseResult.status !== "valid") {
    return baseResult;
  }

  // Probe GitHub Models API to detect models:read permission
  const capabilities: KeyValidationResult["capabilities"] = [];
  try {
    const modelsResponse = await fetch(
      "https://models.inference.ai.azure.com/models",
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (modelsResponse.ok) {
      capabilities.push("github-models");
    }
  } catch {
    // Probe failed — models:read not available
  }

  return { ...baseResult, capabilities };
}

async function validateAnthropicKey(
  key: string
): Promise<KeyValidationResult> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      return { status: "invalid", error: "Authentication failed" };
    }

    if (!response.ok) {
      return {
        status: "error",
        error: `Anthropic API returned ${response.status}`,
      };
    }

    return { status: "valid" };
  } catch (err) {
    return {
      status: "error",
      error: `Anthropic key validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function validateAnthropicOAuth(
  _token: string
): Promise<KeyValidationResult> {
  // OAuth tokens from Claude Code subscriptions cannot be validated against
  // the Anthropic REST API — the API rejects them with "OAuth authentication
  // is currently not supported". Accept structurally (like cookie-state).
  // The token will be validated implicitly when Claude Code CLI uses it.
  return { status: "valid" };
}

async function validateGitHubOAuthCookieState(
  value: string
): Promise<KeyValidationResult> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return { status: "invalid", error: "OAuth cookie state is not a valid JSON object" };
    }
    // Structural check — we can't validate the session without a browser
    return { status: "valid" };
  } catch (err) {
    return {
      status: "invalid",
      error: `OAuth cookie state is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate an Azure AI Foundry credential. The secret is a JSON blob with
 * `endpoint` + `apiKey` (+ optional `model`). We probe the inference
 * endpoint's `/info` route which returns model metadata for the deployment
 * targeted by the key — cheap enough to run on the validation schedule.
 */
async function validateAzureAiFoundry(
  value: string
): Promise<KeyValidationResult> {
  const parsed = parseAzureAiFoundrySecret(value);
  if (!parsed) {
    return {
      status: "invalid",
      error: "Foundry credential must be a JSON object with `endpoint` and `apiKey` string fields",
    };
  }

  // Try `/info` first (cheapest probe). Some Foundry resources require an
  // api-version query parameter — pin to a recent inference API version.
  const url = `${parsed.endpoint}/info?api-version=2024-05-01-preview`;
  try {
    const response = await fetch(url, {
      headers: {
        "api-key": parsed.apiKey,
        Authorization: `Bearer ${parsed.apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 || response.status === 403) {
      return { status: "invalid", error: `Authentication failed (HTTP ${response.status})` };
    }

    if (!response.ok) {
      return {
        status: "error",
        error: `Foundry endpoint returned HTTP ${response.status} for ${url}`,
      };
    }

    return { status: "valid" };
  } catch (err) {
    return {
      status: "error",
      error: `Foundry validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseRateLimit(
  headers: Headers
): KeyValidationResult["rateLimit"] | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");

  if (!limit || !remaining || !reset) {
    return undefined;
  }

  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    reset: new Date(parseInt(reset, 10) * 1000),
  };
}
