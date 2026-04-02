// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { KeyCapability, KeyType, KeyValidationResult } from "./types.js";

/**
 * Static matrix: which capabilities each key type can provide,
 * given the scopes/permissions detected during validation.
 */

/**
 * Derive the capabilities a key supports based on its type and
 * the validation result (scopes, probe results).
 *
 * This is the single source of truth for the capability matrix:
 *
 * | Key Type                 | Condition              | Capabilities                                          |
 * |--------------------------|------------------------|-------------------------------------------------------|
 * | github-pat-classic       | has `copilot` scope    | copilot-sdk, copilot-cli                              |
 * | github-pat-fine-grained  | has `models:read`      | github-models                                         |
 * | github-oauth             | (always)               | github-models, copilot-models, copilot-sdk, copilot-cli |
 * | anthropic-api-key        | (always)               | claude-code-cli, anthropic-api                        |
 * | anthropic-oauth          | (always)               | claude-code-cli                                       |
 */
export function deriveCapabilities(
  type: KeyType,
  result: KeyValidationResult
): KeyCapability[] {
  if (result.status !== "valid") {
    return [];
  }

  switch (type) {
    case "github-pat-classic": {
      const caps: KeyCapability[] = [];
      const scopes = result.scopes ?? [];
      if (scopes.includes("copilot")) {
        caps.push("copilot-sdk", "copilot-cli");
      }
      return caps;
    }

    case "github-pat-fine-grained": {
      const caps: KeyCapability[] = [];
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
      return ["claude-code-cli", "anthropic-api"];

    case "anthropic-oauth":
      return ["claude-code-cli"];

    default:
      return [];
  }
}
