// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseGateListOption, parseGatesOption, parsePromptTypeOption } from "./gates.js";

describe("gate CLI parsing", () => {
  it("parses and orders GateConfig[] JSON", () => {
    const gates = parseGatesOption(JSON.stringify([
      { gate: "test", promptId: "prompt-test", criteria: ["tests_pass"], maxIterations: 2 },
      { gate: "select", criteria: ["implements_task"] },
      { gate: "build", promptId: "prompt-build", criteria: [], maxIterations: 1 },
    ]), 3);

    expect(gates).toEqual([
      { gate: "select", promptId: "", criteria: ["implements_task"] },
      { gate: "build", promptId: "prompt-build", criteria: [], maxIterations: 1 },
      { gate: "test", promptId: "prompt-test", criteria: ["tests_pass"], maxIterations: 2 },
    ]);
  });

  it("rejects invalid gate configs using shared validation", () => {
    expect(() => parseGatesOption(JSON.stringify([
      { gate: "build", promptId: "prompt-build", criteria: [] },
    ]), 3)).toThrow("must select at least one criterion");
  });

  it("parses gate compatibility lists", () => {
    expect(parseGateListOption(["build,test", "run"])).toEqual(["build", "test", "run"]);
    expect(parseGateListOption("all")).toEqual([]);
    expect(() => parseGateListOption("compile")).toThrow("Invalid gate");
  });

  it("validates prompt type options", () => {
    expect(parsePromptTypeOption("build")).toBe("build");
    expect(() => parsePromptTypeOption("compile")).toThrow("Invalid prompt type");
  });
});
