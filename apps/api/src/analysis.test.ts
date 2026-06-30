// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { computeAnalysis, capRunsToLimit, type AnalyzableRun } from "./analysis.js";
import { computeTaskPromptId } from "shared";

describe("computeAnalysis – taskPromptId grouping", () => {
  const kValues = [1, 5];

  function makeRun(overrides: Partial<AnalyzableRun> & { task: string; workerType: string }): AnalyzableRun {
    const { task, workerType, ...rest } = overrides;
    return {
      scenario: { task, criteria: ["c1"] },
      workerType,
      status: "done",
      outcome: "succeeded",
      turns: [{ iteration: 1, passed: true, criteriaResults: [] }],
      ...rest,
    };
  }

  it("groups runs by taskPromptId when present", () => {
    const tpId = computeTaskPromptId("Create an API");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Create an API", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Create an API", workerType: "agent-a", taskPromptId: tpId }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].taskPromptId).toBe(tpId);
    expect(result.groups[0].task).toBe("Create an API");
    expect(result.groups[0].total).toBe(2);
  });

  it("falls back to computing ID from task text for legacy runs without taskPromptId", () => {
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Build a CLI", workerType: "agent-a" }), // no taskPromptId
      makeRun({ task: "Build a CLI", workerType: "agent-a" }), // no taskPromptId
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].taskPromptId).toBe(computeTaskPromptId("Build a CLI"));
  });

  it("groups mixed runs (with and without taskPromptId) by same computed ID", () => {
    const tpId = computeTaskPromptId("Deploy to Azure");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Deploy to Azure", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Deploy to Azure", workerType: "agent-a" }), // legacy — no taskPromptId
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].total).toBe(2);
  });

  it("separates different tasks into different groups", () => {
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Task A", workerType: "agent-a", taskPromptId: computeTaskPromptId("Task A") }),
      makeRun({ task: "Task B", workerType: "agent-a", taskPromptId: computeTaskPromptId("Task B") }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(2);
  });

  it("separates same task with different workers into different groups", () => {
    const tpId = computeTaskPromptId("Same task");
    const runs: AnalyzableRun[] = [
      makeRun({ task: "Same task", workerType: "agent-a", taskPromptId: tpId }),
      makeRun({ task: "Same task", workerType: "agent-b", taskPromptId: tpId }),
    ];

    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(2);
    const workers = result.groups.map((g) => g.workerType).sort();
    expect(workers).toEqual(["agent-a", "agent-b"]);
  });
});

describe("computeAnalysis – durationStats", () => {
  const kValues = [1];

  function makeRunWithDurations(
    durations: (number | undefined)[],
    passed: boolean
  ): AnalyzableRun {
    return {
      scenario: { task: "Task X", criteria: ["c1"] },
      taskPromptId: computeTaskPromptId("Task X"),
      workerType: "agent-a",
      status: "done",
      outcome: "succeeded",
      turns: durations.map((d, i) => ({
        iteration: i + 1,
        passed: i === durations.length - 1 ? passed : false,
        criteriaResults: [],
        durationMs: d,
      })),
    };
  }

  it("computes durationStats as total run duration across passed runs", () => {
    const runs = [
      makeRunWithDurations([10000, 20000], true),   // total = 30000
      makeRunWithDurations([15000], true),           // total = 15000
    ];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups).toHaveLength(1);
    const ds = result.groups[0].durationStats;
    expect(ds).not.toBeNull();
    // Run totals: 30000, 15000 → mean = 22500
    expect(ds!.mean).toBe(22500);
    expect(ds!.min).toBe(15000);
    expect(ds!.max).toBe(30000);
  });

  it("returns null durationStats when no passed runs", () => {
    const runs = [makeRunWithDurations([10000], false)];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups[0].durationStats).toBeNull();
  });

  it("returns null durationStats when passed runs have no durationMs", () => {
    const runs = [makeRunWithDurations([undefined], true)];
    const result = computeAnalysis(runs, kValues);
    expect(result.groups[0].durationStats).toBeNull();
  });
});

describe("computeAnalysis – task prompt feature filtering", () => {
  const kValues = [1, 5];

  function makeRun(
    task: string,
    promptFeatures?: AnalyzableRun["promptFeatures"],
    criteria: string[] = ["c1"],
  ): AnalyzableRun {
    return {
      scenario: { task, criteria },
      taskPromptId: computeTaskPromptId(task),
      promptFeatures,
      workerType: "agent-a",
      status: "done",
      outcome: "succeeded",
      turns: [{ iteration: 1, passed: true, criteriaResults: [] }],
    };
  }

  it("availableFeatures is the detected-only union (ignores detected:false)", () => {
    const runs: AnalyzableRun[] = [
      makeRun("Task A", [
        { featureId: "asks_for_azure", detected: true },
        { featureId: "asks_for_database", detected: false },
      ]),
      makeRun("Task B", [
        { featureId: "asks_for_ui", detected: true },
        { featureId: "asks_for_azure", detected: false },
      ]),
    ];
    const result = computeAnalysis(runs, kValues);
    // asks_for_database / (B's) asks_for_azure are only ever detected:false -> still
    // included because azure is detected on A and ui on B; database never detected.
    expect(result.availableFeatures).toEqual(["asks_for_azure", "asks_for_ui"]);
    expect(result.availableFeatures).not.toContain("asks_for_database");
  });

  it("filters to runs whose task prompt has the selected feature detected", () => {
    const runs: AnalyzableRun[] = [
      makeRun("Task A", [{ featureId: "asks_for_azure", detected: true }]),
      makeRun("Task B", [{ featureId: "asks_for_azure", detected: false }]),
      makeRun("Task C", [{ featureId: "asks_for_ui", detected: true }]),
    ];
    const result = computeAnalysis(runs, kValues, undefined, ["asks_for_azure"]);
    expect(result.summary.totalRuns).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].task).toBe("Task A");
    expect(result.selectedFeatures).toEqual(["asks_for_azure"]);
  });

  it("AND-filters across multiple selected features", () => {
    const runs: AnalyzableRun[] = [
      makeRun("Both", [
        { featureId: "asks_for_azure", detected: true },
        { featureId: "asks_for_database", detected: true },
      ]),
      makeRun("AzureOnly", [
        { featureId: "asks_for_azure", detected: true },
        { featureId: "asks_for_database", detected: false },
      ]),
    ];
    const result = computeAnalysis(runs, kValues, undefined, [
      "asks_for_azure",
      "asks_for_database",
    ]);
    expect(result.summary.totalRuns).toBe(1);
    expect(result.groups[0].task).toBe("Both");
  });

  it("excludes runs without detected features when a feature filter is active", () => {
    const runs: AnalyzableRun[] = [
      makeRun("HasFeature", [{ featureId: "asks_for_azure", detected: true }]),
      makeRun("NoFeatures", undefined),
      makeRun("OnlyUndetected", [{ featureId: "asks_for_azure", detected: false }]),
    ];
    const result = computeAnalysis(runs, kValues, undefined, ["asks_for_azure"]);
    expect(result.summary.totalRuns).toBe(1);
    expect(result.groups[0].task).toBe("HasFeature");
  });

  it("combines criteria and feature filtering (both must match)", () => {
    const runs: AnalyzableRun[] = [
      // matches both: has c-azure criterion AND azure feature detected
      makeRun("Match", [{ featureId: "asks_for_azure", detected: true }], ["c-azure"]),
      // right feature, wrong criteria
      makeRun("WrongCriteria", [{ featureId: "asks_for_azure", detected: true }], ["c-other"]),
      // right criteria, feature not detected
      makeRun("WrongFeature", [{ featureId: "asks_for_azure", detected: false }], ["c-azure"]),
    ];
    const result = computeAnalysis(runs, kValues, ["c-azure"], ["asks_for_azure"]);
    expect(result.summary.totalRuns).toBe(1);
    expect(result.groups[0].task).toBe("Match");
  });

  it("returns empty selectedFeatures and a populated availableFeatures union when no filter is active", () => {
    const runs: AnalyzableRun[] = [
      makeRun("Task A", [{ featureId: "asks_for_azure", detected: true }]),
    ];
    const result = computeAnalysis(runs, kValues);
    expect(result.selectedFeatures).toEqual([]);
    expect(result.availableFeatures).toEqual(["asks_for_azure"]);
  });
});

describe("capRunsToLimit – memory bound", () => {
  it("returns the list untouched when at or below the cap", () => {
    const runs = [1, 2, 3];
    const atCap = capRunsToLimit(runs, 3);
    expect(atCap.truncated).toBe(false);
    expect(atCap.runs).toBe(runs); // same reference, no copy

    const belowCap = capRunsToLimit(runs, 10);
    expect(belowCap.truncated).toBe(false);
    expect(belowCap.runs).toEqual([1, 2, 3]);
  });

  it("trims to the cap and flags truncation when exceeded", () => {
    // The route fetches cap+1 to detect "more exist"; simulate that here.
    const fetched = [1, 2, 3, 4]; // cap+1 for a cap of 3
    const { runs, truncated } = capRunsToLimit(fetched, 3);
    expect(truncated).toBe(true);
    expect(runs).toEqual([1, 2, 3]); // keeps the most-recent N (already sorted)
    expect(runs).toHaveLength(3);
  });

  it("handles an empty list", () => {
    const { runs, truncated } = capRunsToLimit([], 5);
    expect(truncated).toBe(false);
    expect(runs).toEqual([]);
  });
});
