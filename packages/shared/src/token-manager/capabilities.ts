// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TokenCapability, TokenType, TokenValidationResult } from "./types.js";

/**
 * Static matrix: which capabilities each token type can provide,
 * given the scopes/permissions detected during validation.
 */

/**
 * Derive the capabilities a token supports based on its type and
 * the validation result (scopes, probe results).
 *
 * This is the single source of truth for the capability matrix:
 *
 * | Token Type               | Condition              | Capabilities                                          |
 * |--------------------------|------------------------|-------------------------------------------------------|
 * | github-pat-fine-grained  | has `models:read`      | github-models                                         |
 * | anthropic-api-key        | (always)               | claude-code-cli                                       |
 */
export function deriveCapabilities(
  type: TokenType,
  result: TokenValidationResult
): TokenCapability[] {
  if (result.status !== "valid") {
    return [];
  }

  switch (type) {
    case "github-pat-classic": {
      const caps: TokenCapability[] = [];
      const scopes = result.scopes ?? [];
      if (scopes.includes("copilot")) {
        caps.push("copilot-sdk", "copilot-cli");
      }
      return caps;
    }

    case "github-pat-fine-grained": {
      const caps: TokenCapability[] = [];
      // Fine-grained PAT capabilities are detected via API probing
      // during validation (models:read → github-models).
      // The validator sets result.capabilities directly for probed caps.
      if (result.capabilities?.includes("github-models")) {
        caps.push("github-models");
      }
      return caps;
    }

    case "github-oauth":
      return ["github-models", "copilot-models", "copilot-sdk", "copilot-cli"];

    case "github-oauth-cookie-state":
      return [];

    case "anthropic-api-key":
      return ["claude-code-cli"];

    default:
      return [];
  }
}
