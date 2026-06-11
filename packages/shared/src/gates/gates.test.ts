// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  normalizeGates,
  orderGates,
  validateGateConfigs,
  isCriterionCompatibleWithGate,
  gatesSatisfyInvariant,
} from "./gates.js";
import { GateConfig } from "../types/types.js";

describe("normalizeGates", () => {
  it("normalises an absent gates config to a single Select gate", () => {
    const gates = normalizeGates({
      scenarioCriteria: ["a", "b"],
      maxIterations: 5,
      taskPromptId: "tp-1",
    });
    expect(gates).toEqual([
      { gate: "select", promptId: "tp-1", criteria: ["a", "b"], maxIterations: 5 },
    ]);
  });

  it("normalises an empty gates array to a single Select gate", () => {
    const gates = normalizeGates({ gates: [], scenarioCriteria: ["x"], taskPromptId: "tp" });
    expect(gates).toHaveLength(1);
    expect(gates[0].gate).toBe("select");
    expect(gates[0].criteria).toEqual(["x"]);
  });

  it("returns provided gates ordered by GATE_ORDER", () => {
    const input: GateConfig[] = [
      { gate: "test", promptId: "p-test", criteria: ["t"] },
      { gate: "select", promptId: "p-sel", criteria: ["s"] },
      { gate: "build", promptId: "p-build", criteria: ["b"] },
    ];
    const ordered = normalizeGates({ gates: input });
    expect(ordered.map((g) => g.gate)).toEqual(["select", "build", "test"]);
  });

  it("omits maxIterations when not provided", () => {
    const gates = normalizeGates({ scenarioCriteria: ["a"], taskPromptId: "tp" });
    expect(gates[0]).not.toHaveProperty("maxIterations");
  });
});

describe("orderGates", () => {
  it("sorts gates into canonical order without mutating input", () => {
    const input: GateConfig[] = [
      { gate: "deploy", promptId: "d", criteria: [] },
      { gate: "select", promptId: "s", criteria: ["s"] },
    ];
    const ordered = orderGates(input);
    expect(ordered.map((g) => g.gate)).toEqual(["select", "deploy"]);
    expect(input[0].gate).toBe("deploy"); // not mutated
  });
});

describe("validateGateConfigs", () => {
  it("accepts a gate with ≥1 criterion", () => {
    const errors = validateGateConfigs([
      { gate: "build", promptId: "p", criteria: ["builds_clean"], maxIterations: 3 },
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts a pass-through gate (maxIterations 1, no criteria)", () => {
    const errors = validateGateConfigs([
      { gate: "build", promptId: "p", criteria: [], maxIterations: 1 },
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects a gate with no criteria when maxIterations > 1", () => {
    const errors = validateGateConfigs([
      { gate: "build", promptId: "p", criteria: [], maxIterations: 3 },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("at least one criterion");
  });

  it("uses the request default maxIterations when the gate omits it", () => {
    const errors = validateGateConfigs(
      [{ gate: "build", promptId: "p", criteria: [] }],
      1,
    );
    expect(errors).toEqual([]);
  });

  it("rejects duplicate gates", () => {
    const errors = validateGateConfigs([
      { gate: "build", promptId: "p", criteria: ["a"] },
      { gate: "build", promptId: "p2", criteria: ["b"] },
    ]);
    expect(errors.some((e) => e.includes("more than once"))).toBe(true);
  });

  it("rejects an unknown gate", () => {
    const errors = validateGateConfigs([
      { gate: "bogus" as any, promptId: "p", criteria: ["a"] },
    ]);
    expect(errors.some((e) => e.includes("Unknown gate"))).toBe(true);
  });
});

describe("isCriterionCompatibleWithGate", () => {
  it("treats empty/undefined as compatible with all gates", () => {
    expect(isCriterionCompatibleWithGate(undefined, "build")).toBe(true);
    expect(isCriterionCompatibleWithGate([], "deploy")).toBe(true);
  });

  it("matches against the declared list", () => {
    expect(isCriterionCompatibleWithGate(["build", "test"], "build")).toBe(true);
    expect(isCriterionCompatibleWithGate(["build"], "select")).toBe(false);
  });
});

describe("gatesSatisfyInvariant (downward-closed: parent ⊇ child)", () => {
  it("passes when parent is unrestricted", () => {
    expect(gatesSatisfyInvariant(undefined, ["build"])).toBe(true);
    expect(gatesSatisfyInvariant([], ["build", "test"])).toBe(true);
  });

  it("fails when parent restricted but child unrestricted", () => {
    expect(gatesSatisfyInvariant(["build"], undefined)).toBe(false);
    expect(gatesSatisfyInvariant(["build"], [])).toBe(false);
  });

  it("passes when parent superset of child", () => {
    expect(gatesSatisfyInvariant(["build", "test"], ["build"])).toBe(true);
  });

  it("fails when child has a gate the parent lacks", () => {
    expect(gatesSatisfyInvariant(["select"], ["build"])).toBe(false);
  });
});
