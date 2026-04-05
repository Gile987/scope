// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { groupRuns, formatStatRange } from "./grouping";
import type { Run } from "../types";

// Re-export internals for testing via a test-only helper
// Since computeStats is private, we test it indirectly through groupRuns

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    _id: Math.random().toString(36).slice(2),
    id: "",
    workerType: "coder-acp-copilot",
    status: "completed",
    createdAt: new Date().toISOString(),
    scenario: { task: "Default task", criteria: [] },
    ...overrides,
  };
}

describe("groupRuns", () => {
  it("returns empty array when groupBy is 'none'", () => {
    const runs = [makeRun(), makeRun()];
    expect(groupRuns(runs, "none")).toEqual([]);
  });

  it("groups by task using taskPromptId", () => {
    const runs = [
      makeRun({ taskPromptId: "t1", scenario: { task: "Task A", criteria: [] } }),
      makeRun({ taskPromptId: "t1", scenario: { task: "Task A", criteria: [] } }),
      makeRun({ taskPromptId: "t2", scenario: { task: "Task B", criteria: [] } }),
    ];
    const groups = groupRuns(runs, "task");
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("t1");
    expect(groups[0].label).toBe("Task A");
    expect(groups[0].runs).toHaveLength(2);
    expect(groups[1].key).toBe("t2");
    expect(groups[1].runs).toHaveLength(1);
  });

  it("falls back to scenario.task when taskPromptId is missing", () => {
    const runs = [
      makeRun({ scenario: { task: "Same task", criteria: [] } }),
      makeRun({ scenario: { task: "Same task", criteria: [] } }),
    ];
    const groups = groupRuns(runs, "task");
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("Same task");
    expect(groups[0].runs).toHaveLength(2);
  });

  it("groups by submissionId", () => {
    const runs = [
      makeRun({ submissionId: "sub-1" }),
      makeRun({ submissionId: "sub-1" }),
      makeRun({ submissionId: "sub-2" }),
      makeRun({}), // no submissionId
    ];
    const groups = groupRuns(runs, "submissionId");
    expect(groups).toHaveLength(3);

    const sub1 = groups.find((g) => g.key === "sub-1");
    expect(sub1?.runs).toHaveLength(2);
    expect(sub1?.label).toBe("sub-1");

    const noSub = groups.find((g) => g.key === "no-submission");
    expect(noSub?.runs).toHaveLength(1);
    expect(noSub?.label).toBe("No submission ID");
  });

  it("computes turn aggregates correctly", () => {
    const runs = [
      makeRun({ turns: [{ iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" }] }),
      makeRun({ turns: [
        { iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" },
        { iteration: 2, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" },
        { iteration: 3, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" },
      ] }),
      makeRun({ turns: [
        { iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" },
        { iteration: 2, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "" },
      ] }),
    ];
    // All same taskPromptId so they group together
    runs.forEach((r) => (r.taskPromptId = "t1"));
    const groups = groupRuns(runs, "task");
    expect(groups).toHaveLength(1);
    const agg = groups[0].aggregates;
    expect(agg.count).toBe(3);
    expect(agg.turns).not.toBeNull();
    expect(agg.turns!.min).toBe(1);
    expect(agg.turns!.max).toBe(3);
    expect(agg.turns!.mean).toBe(2); // (1+3+2)/3
  });

  it("computes duration aggregates from turn durationMs", () => {
    const runs = [
      makeRun({
        taskPromptId: "t1",
        turns: [
          { iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "", durationMs: 10000 },
          { iteration: 2, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "", durationMs: 20000 },
        ],
      }),
      makeRun({
        taskPromptId: "t1",
        turns: [
          { iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: true, timestamp: "", durationMs: 5000 },
        ],
      }),
    ];
    const groups = groupRuns(runs, "task");
    const agg = groups[0].aggregates;
    expect(agg.duration).not.toBeNull();
    expect(agg.duration!.min).toBe(5000);  // 5s
    expect(agg.duration!.max).toBe(30000); // 10+20=30s
    expect(agg.duration!.mean).toBe(17500); // (30000+5000)/2
  });

  it("computes token aggregates", () => {
    const runs = [
      makeRun({
        taskPromptId: "t1",
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }),
      makeRun({
        taskPromptId: "t1",
        tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      }),
    ];
    const groups = groupRuns(runs, "task");
    const agg = groups[0].aggregates;
    expect(agg.promptTokens).not.toBeNull();
    expect(agg.promptTokens!.min).toBe(100);
    expect(agg.promptTokens!.max).toBe(200);
    expect(agg.promptTokens!.mean).toBe(150);
    expect(agg.completionTokens!.min).toBe(50);
    expect(agg.completionTokens!.max).toBe(100);
  });

  it("handles runs with no turns or tokens gracefully", () => {
    const runs = [
      makeRun({ taskPromptId: "t1" }), // no turns, no tokens
      makeRun({ taskPromptId: "t1" }),
    ];
    const groups = groupRuns(runs, "task");
    const agg = groups[0].aggregates;
    expect(agg.count).toBe(2);
    expect(agg.turns).toBeNull();
    expect(agg.duration).toBeNull();
    expect(agg.promptTokens).toBeNull();
    expect(agg.completionTokens).toBeNull();
  });

  it("handles empty runs array", () => {
    expect(groupRuns([], "task")).toEqual([]);
    expect(groupRuns([], "submissionId")).toEqual([]);
  });
});

describe("formatStatRange", () => {
  it("returns dash for null stats", () => {
    expect(formatStatRange(null)).toBe("–");
  });

  it("returns single value when min equals max", () => {
    expect(formatStatRange({ min: 5, max: 5, mean: 5, stdDev: 0 })).toBe("5");
  });

  it("returns range with mean and stddev", () => {
    const result = formatStatRange({ min: 2, max: 10, mean: 6, stdDev: 2.5 });
    expect(result).toContain("2");
    expect(result).toContain("10");
    expect(result).toContain("μ6");
    expect(result).toContain("σ2.5");
  });

  it("uses custom formatter", () => {
    const fmt = (v: number) => `${v}ms`;
    const result = formatStatRange({ min: 100, max: 200, mean: 150, stdDev: 30 }, fmt);
    expect(result).toContain("100ms");
    expect(result).toContain("200ms");
  });
});
