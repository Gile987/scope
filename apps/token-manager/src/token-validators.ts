// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TokenType, TokenValidationResult } from "shared";

/**
 * Validate a token by calling the provider's API.
 * Returns a result object — never throws.
 */
export async function validateToken(
  type: TokenType,
  value: string
): Promise<TokenValidationResult> {
  switch (type) {
    case "github-pat":
      return validateGitHubPat(value);
    case "anthropic-api-key":
      return validateAnthropicKey(value);
    case "github-models-api-key":
      return validateGitHubModelsKey(value);
    case "github-oauth-state":
      return validateGitHubOAuthState(value);
    default:
      return { status: "error", error: `Unknown token type: ${type}` };
  }
}

async function validateGitHubPat(
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
      error: `GitHub PAT validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

async function validateGitHubModelsKey(
  key: string
): Promise<TokenValidationResult> {
  try {
    const response = await fetch(
      "https://models.inference.ai.azure.com/info",
      {
        headers: {
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (response.status === 401) {
      return { status: "invalid", error: "Authentication failed" };
    }

    if (!response.ok) {
      return {
        status: "error",
        error: `GitHub Models API returned ${response.status}`,
      };
    }

    return { status: "valid" };
  } catch (err) {
    return {
      status: "error",
      error: `GitHub Models key validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function validateGitHubOAuthState(
  value: string
): Promise<TokenValidationResult> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return { status: "invalid", error: "OAuth state is not a valid JSON object" };
    }
    // Structural check — we can't validate the session without a browser
    return { status: "valid" };
  } catch (err) {
    return {
      status: "invalid",
      error: `OAuth state is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
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
