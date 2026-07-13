// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { extractCriteriaStatus } from "./CriteriaGraphView";
import type { LogEvent, GateId } from "@/types";

function criterionResult(
  criterionId: string,
  passed: boolean,
  evaluated: boolean,
  gate?: GateId,
  iteration?: number
): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    source: "judge",
    message: `criterion_result: ${criterionId}`,
    data: {
      type: "criterion_result",
      criterionId,
      passed,
      evaluated,
      feedback: "",
      ...(gate ? { gate } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
    },
  };
}

function dagStatus(
  results: Array<{ criterionId: string; passed: boolean; evaluated: boolean }>,
  gate?: GateId,
  iteration?: number
): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    source: "judge",
    message: "criteria_dag_status",
    data: {
      type: "criteria_dag_status",
      results,
      ...(gate ? { gate } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
    },
  };
}

describe("extractCriteriaStatus", () => {
  it("aggregates all events when no gate is specified", () => {
    const logs = [
      criterionResult("a", true, true, "select"),
      criterionResult("b", false, true, "build"),
    ];
    const map = extractCriteriaStatus(logs);
    expect(map.get("a")?.passed).toBe(true);
    expect(map.get("b")?.passed).toBe(false);
    expect(map.size).toBe(2);
  });

  it("scopes status to the requested gate", () => {
    const logs = [
      criterionResult("shared", true, true, "select"),
      criterionResult("shared", false, true, "build"),
    ];
    expect(extractCriteriaStatus(logs, "select").get("shared")?.passed).toBe(true);
    expect(extractCriteriaStatus(logs, "build").get("shared")?.passed).toBe(false);
  });

  it("treats events without a gate tag as the Select gate", () => {
    const logs = [criterionResult("legacy", true, true)];
    expect(extractCriteriaStatus(logs, "select").get("legacy")?.passed).toBe(true);
    expect(extractCriteriaStatus(logs, "build").has("legacy")).toBe(false);
  });

  it("ignores other gates' events when scoping", () => {
    const logs = [
      criterionResult("build_only", true, true, "build"),
      criterionResult("test_only", true, true, "test"),
    ];
    const buildMap = extractCriteriaStatus(logs, "build");
    expect(buildMap.has("build_only")).toBe(true);
    expect(buildMap.has("test_only")).toBe(false);
  });

  it("scopes batched criteria_dag_status events by gate", () => {
    const logs = [
      dagStatus([{ criterionId: "x", passed: true, evaluated: true }], "select", 1),
      dagStatus([{ criterionId: "x", passed: false, evaluated: true }], "build", 2),
    ];
    const selectMap = extractCriteriaStatus(logs, "select");
    expect(selectMap.get("x")?.passed).toBe(true);
    expect(selectMap.get("x")?.iteration).toBe(1);

    const buildMap = extractCriteriaStatus(logs, "build");
    expect(buildMap.get("x")?.passed).toBe(false);
    expect(buildMap.get("x")?.iteration).toBe(2);
  });
});
