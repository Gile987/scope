// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TokenType, TokenValidationResult, deriveCapabilities } from "shared";

/**
 * Validate a token by calling the provider's API and derive its capabilities.
 * Returns a result object — never throws.
 */
export async function validateToken(
  type: TokenType,
  value: string
): Promise<TokenValidationResult> {
  let result: TokenValidationResult;

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
): Promise<TokenValidationResult> {
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
): Promise<TokenValidationResult> {
  // First validate the token itself
  const baseResult = await validateGitHubToken(token);
  if (baseResult.status !== "valid") {
    return baseResult;
  }

  // Probe GitHub Models API to detect models:read permission
  const capabilities: TokenValidationResult["capabilities"] = [];
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
): Promise<TokenValidationResult> {
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
  token: string
): Promise<TokenValidationResult> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        Authorization: `Bearer ${token}`,
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
      error: `Anthropic OAuth validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function validateGitHubOAuthCookieState(
  value: string
): Promise<TokenValidationResult> {
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

function parseRateLimit(
  headers: Headers
): TokenValidationResult["rateLimit"] | undefined {
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
