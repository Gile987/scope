// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import {
  AUTOPILOT_OPTION_DESCRIPTOR,
  WORKER_AGENT_OPTIONS,
  getAgentOptionDescriptors,
  buildAgentOptionsSchema,
  validateAgentOptions,
  mergeAgentOptions,
  type AgentOptionDescriptor,
} from "./agent-options.js";

describe("WORKER_AGENT_OPTIONS", () => {
  it("advertises autopilot for Copilot and VS Code workers", () => {
    for (const worker of [
      "coder-acp-copilot",
      "coder-acp-copilot-windows",
      "coder-vscode-web",
      "coder-vscode-electron-driver-ext",
    ]) {
      expect(WORKER_AGENT_OPTIONS[worker]).toEqual([AUTOPILOT_OPTION_DESCRIPTOR]);
    }
  });

  it("advertises no options for Claude Code (autonomous, no autopilot axis)", () => {
    expect(WORKER_AGENT_OPTIONS["coder-acp-claude-code"]).toEqual([]);
  });
});

describe("getAgentOptionDescriptors", () => {
  it("prefers advertised descriptors from the agent document", () => {
    const advertised: AgentOptionDescriptor[] = [
      { key: "custom", type: "string", label: "Custom" },
    ];
    expect(getAgentOptionDescriptors("coder-acp-copilot", advertised)).toBe(advertised);
  });

  it("falls back to the canonical map when none advertised", () => {
    expect(getAgentOptionDescriptors("coder-acp-copilot")).toEqual([
      AUTOPILOT_OPTION_DESCRIPTOR,
    ]);
  });

  it("returns [] for an unknown worker with no advertised descriptors", () => {
    expect(getAgentOptionDescriptors("unknown-worker")).toEqual([]);
  });
});

describe("buildAgentOptionsSchema", () => {
  it("accepts a valid boolean option and rejects the wrong type", () => {
    const schema = buildAgentOptionsSchema([AUTOPILOT_OPTION_DESCRIPTOR]);
    expect(schema.safeParse({ autopilot: true }).success).toBe(true);
    expect(schema.safeParse({ autopilot: "yes" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const schema = buildAgentOptionsSchema([AUTOPILOT_OPTION_DESCRIPTOR]);
    expect(schema.safeParse({ nope: true }).success).toBe(false);
  });

  it("an empty descriptor list rejects any option", () => {
    const schema = buildAgentOptionsSchema([]);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ autopilot: true }).success).toBe(false);
  });

  it("validates enum options against their allowed values", () => {
    const schema = buildAgentOptionsSchema([
      { key: "mode", type: "enum", label: "Mode", enum: ["a", "b"] },
    ]);
    expect(schema.safeParse({ mode: "a" }).success).toBe(true);
    expect(schema.safeParse({ mode: "c" }).success).toBe(false);
  });
});

describe("validateAgentOptions", () => {
  it("treats undefined options as an empty bag", () => {
    expect(validateAgentOptions("coder-acp-copilot", undefined)).toEqual({
      success: true,
      data: {},
    });
  });

  it("accepts autopilot for Copilot", () => {
    const result = validateAgentOptions("coder-acp-copilot", { autopilot: true });
    expect(result).toEqual({ success: true, data: { autopilot: true } });
  });

  it("rejects autopilot for Claude Code (advertises no options)", () => {
    const result = validateAgentOptions("coder-acp-claude-code", { autopilot: true });
    expect(result.success).toBe(false);
  });

  it("returns a human-readable error string on failure", () => {
    const result = validateAgentOptions("coder-acp-copilot", { autopilot: "nope" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("autopilot");
    }
  });
});

describe("mergeAgentOptions", () => {
  it("returns undefined when neither side contributes keys", () => {
    expect(mergeAgentOptions(undefined, undefined)).toBeUndefined();
    expect(mergeAgentOptions({}, {})).toBeUndefined();
  });

  it("returns the non-empty side when the other is undefined", () => {
    expect(mergeAgentOptions({ autopilot: true }, undefined)).toEqual({ autopilot: true });
    expect(mergeAgentOptions(undefined, { autopilot: false })).toEqual({ autopilot: false });
  });

  it("lets profile keys override request keys (per-key merge)", () => {
    expect(
      mergeAgentOptions({ autopilot: false, foo: 1 }, { autopilot: true }),
    ).toEqual({ autopilot: true, foo: 1 });
  });
});
