// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { buildGroupingPipeline, computeStats } from "./grouping.js";

describe("buildGroupingPipeline", () => {
  it("returns 4 pipeline stages for task grouping", () => {
    const pipeline = buildGroupingPipeline("task");
    expect(pipeline).toHaveLength(4);
    expect(pipeline[0]).toHaveProperty("$addFields");
    expect(pipeline[1]).toHaveProperty("$group");
    expect(pipeline[2]).toHaveProperty("$project");
    expect(pipeline[3]).toHaveProperty("$sort");
  });

  it("returns 4 pipeline stages for submissionId grouping", () => {
    const pipeline = buildGroupingPipeline("submissionId");
    expect(pipeline).toHaveLength(4);
  });

  it("$sort stage orders by label ascending", () => {
    const pipeline = buildGroupingPipeline("task");
    expect(pipeline[3]).toEqual({ $sort: { label: 1 } });
  });

  it("groups by taskPromptId for task grouping", () => {
    const pipeline = buildGroupingPipeline("task");
    const addFields = pipeline[0].$addFields as Record<string, unknown>;
    // _groupKey should reference $taskPromptId with fallback to scenario.task
    expect(addFields._groupKey).toBeDefined();
  });

  it("groups by submissionId for submissionId grouping", () => {
    const pipeline = buildGroupingPipeline("submissionId");
    const addFields = pipeline[0].$addFields as Record<string, unknown>;
    expect(addFields._groupKey).toBeDefined();
  });

  it("$group stage uses _groupKey as _id", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._id).toBe("$_groupKey");
  });

  it("$group stage accumulates count and stat arrays", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group.count).toEqual({ $sum: 1 });
    expect(group._turnCounts).toBeDefined();
    expect(group._durations).toBeDefined();
    expect(group._promptTokensList).toBeDefined();
    expect(group._completionTokensList).toBeDefined();
  });

  it("$group stage accumulates status and outcome counts", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._statusPending).toBeDefined();
    expect(group._statusProcessing).toBeDefined();
    expect(group._statusDone).toBeDefined();
    expect(group._outcomeSucceeded).toBeDefined();
    expect(group._outcomeFailed).toBeDefined();
    expect(group._outcomeFinished).toBeDefined();
  });

  it("$group stage collects distinct values for uniform detection", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._workerTypes).toBeDefined();
    expect(group._models).toBeDefined();
    expect(group._agentVersions).toBeDefined();
    expect(group._platforms).toBeDefined();
    expect(group._statuses).toBeDefined();
    expect(group._submissionIds).toBeDefined();
    expect(group._tasks).toBeDefined();
    expect(group._mcpKeys).toBeDefined();
    expect(group._skillKeys).toBeDefined();
  });

  it("$group stage collects run IDs", () => {
    const pipeline = buildGroupingPipeline("task");
    const group = pipeline[1].$group as Record<string, unknown>;
    expect(group._runIds).toEqual({ $push: "$_id" });
  });

  it("$project stage outputs key, label, runIds, aggregates, uniform", () => {
    const pipeline = buildGroupingPipeline("task");
    const project = (pipeline[2] as { $project: Record<string, unknown> }).$project;
    expect(project._id).toBe(0);
    expect(project.key).toBeDefined();
    expect(project.runIds).toBe("$_runIds");
    expect(project.label).toBeDefined();
    expect(project.aggregates).toBeDefined();
    expect(project.uniform).toBeDefined();
  });

  it("$project aggregates include statusCounts and outcomeCounts", () => {
    const pipeline = buildGroupingPipeline("task");
    const project = pipeline[2].$project as Record<string, unknown>;
    const aggregates = project.aggregates as Record<string, unknown>;
    expect(aggregates.statusCounts).toEqual({ pending: "$_statusPending", processing: "$_statusProcessing", done: "$_statusDone" });
    expect(aggregates.outcomeCounts).toEqual({ succeeded: "$_outcomeSucceeded", failed: "$_outcomeFailed", finished: "$_outcomeFinished" });
  });
});

describe("computeStats", () => {
  it("returns null for empty array", () => {
    expect(computeStats([])).toBeNull();
  });

  it("computes stats for a single value", () => {
    const result = computeStats([5]);
    expect(result).toEqual({ min: 5, max: 5, mean: 5, stdDev: 0 });
  });

  it("computes min/max/mean/stdDev for multiple values", () => {
    const result = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).not.toBeNull();
    expect(result!.min).toBe(2);
    expect(result!.max).toBe(9);
    expect(result!.mean).toBe(5);
    expect(result!.stdDev).toBeCloseTo(2, 0);
  });

  it("handles identical values", () => {
    const result = computeStats([3, 3, 3]);
    expect(result).toEqual({ min: 3, max: 3, mean: 3, stdDev: 0 });
  });
});
