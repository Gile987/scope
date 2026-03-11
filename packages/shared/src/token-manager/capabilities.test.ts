// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { deriveCapabilities } from "./capabilities.js";
import type { TokenValidationResult } from "./types.js";

const validResult: TokenValidationResult = { status: "valid" };
const invalidResult: TokenValidationResult = { status: "invalid" };

describe("deriveCapabilities", () => {
  it("returns empty array for non-valid status", () => {
    expect(deriveCapabilities("github-oauth", invalidResult)).toEqual([]);
  });

  describe("github-pat-classic", () => {
    it("returns copilot capabilities when copilot scope is present", () => {
      const result: TokenValidationResult = {
        status: "valid",
        scopes: ["copilot", "repo"],
      };
      expect(deriveCapabilities("github-pat-classic", result)).toEqual([
        "copilot-sdk",
        "copilot-cli"
      ]);
    });

    it("does NOT include copilot-models (PATs rejected by Copilot models API)", () => {
      const result: TokenValidationResult = {
        status: "valid",
        scopes: ["copilot"],
      };
      const caps = deriveCapabilities("github-pat-classic", result);
      expect(caps).not.toContain("copilot-models");
    });

    it("returns empty array when copilot scope is missing", () => {
      const result: TokenValidationResult = {
        status: "valid",
        scopes: ["repo"],
      };
      expect(deriveCapabilities("github-pat-classic", result)).toEqual([]);
    });
  });

  describe("github-pat-fine-grained", () => {
    it("returns github-models when capability was probed", () => {
      const result: TokenValidationResult = {
        status: "valid",
        capabilities: ["github-models"],
      };
      expect(deriveCapabilities("github-pat-fine-grained", result)).toEqual([
        "github-models",
      ]);
    });

    it("returns empty array when no capabilities probed", () => {
      expect(deriveCapabilities("github-pat-fine-grained", validResult)).toEqual([]);
    });
  });

  describe("github-oauth", () => {
    it("includes copilot-models capability", () => {
      const caps = deriveCapabilities("github-oauth", validResult);
      expect(caps).toContain("copilot-models");
    });

    it("includes all expected capabilities", () => {
      expect(deriveCapabilities("github-oauth", validResult)).toEqual([
        "github-models",
        "copilot-models",
        "copilot-sdk",
        "copilot-cli"
      ]);
    });
  });
  describe("anthropic-api-key", () => {
    it("returns claude-code-cli", () => {
      expect(deriveCapabilities("anthropic-api-key", validResult)).toEqual([
        "claude-code-cli",
      ]);
    });
  });
});
