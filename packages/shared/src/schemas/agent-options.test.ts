// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

import {
  buildAgentOptionsSchema,
  validateAgentOptions,
  mergeAgentOptions,
  type AgentOptionDescriptor,
} from "./agent-options.js";

// Inline fixture standing in for whatever a worker advertises at registration.
// The module no longer hardcodes any worker's options — descriptors always come
// from the agent document, so tests supply them explicitly.
const autopilotDescriptor: AgentOptionDescriptor = {
  key: "autopilot",
  type: "boolean",
  label: "Autopilot mode",
};

describe("buildAgentOptionsSchema", () => {
  it("accepts a valid boolean option and rejects the wrong type", () => {
    const schema = buildAgentOptionsSchema([autopilotDescriptor]);
    expect(schema.safeParse({ autopilot: true }).success).toBe(true);
    expect(schema.safeParse({ autopilot: "yes" }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const schema = buildAgentOptionsSchema([autopilotDescriptor]);
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
    expect(validateAgentOptions(undefined, [autopilotDescriptor])).toEqual({
      success: true,
      data: {},
    });
  });

  it("accepts an advertised option", () => {
    const result = validateAgentOptions({ autopilot: true }, [autopilotDescriptor]);
    expect(result).toEqual({ success: true, data: { autopilot: true } });
  });

  it("rejects any option when the worker advertises none", () => {
    const result = validateAgentOptions({ autopilot: true }, []);
    expect(result.success).toBe(false);
  });

  it("rejects any option when descriptors are undefined (no fallback)", () => {
    const result = validateAgentOptions({ autopilot: true }, undefined);
    expect(result.success).toBe(false);
  });

  it("returns a human-readable error string on failure", () => {
    const result = validateAgentOptions({ autopilot: "nope" }, [autopilotDescriptor]);
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
