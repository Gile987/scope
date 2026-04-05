// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run } from "../types";

export type GroupByKey = "none" | "task" | "submissionId";

export interface AggregateStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

export interface GroupAggregates {
  count: number;
  turns: AggregateStats | null;
  duration: AggregateStats | null;
  promptTokens: AggregateStats | null;
  completionTokens: AggregateStats | null;
}

export interface RunGroup {
  key: string;
  label: string;
  runs: Run[];
  aggregates: GroupAggregates;
}

function computeStats(values: number[]): AggregateStats | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { min, max, mean, stdDev };
}

function getRunTurns(run: Run): number | null {
  return run.turns?.length ?? null;
}

function getRunDuration(run: Run): number | null {
  if (!run.turns || run.turns.length === 0) return null;
  const total = run.turns.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  return total > 0 ? total : null;
}

function getRunTokens(run: Run): { prompt: number; completion: number } | null {
  const usage =
    run.tokenUsage ??
    (run.turns?.some((t) => t.tokenUsage)
      ? run.turns!.reduce(
          (acc, t) => {
            if (!t.tokenUsage) return acc;
            return {
              promptTokens: acc.promptTokens + t.tokenUsage.promptTokens,
              completionTokens: acc.completionTokens + t.tokenUsage.completionTokens,
              totalTokens: acc.totalTokens + t.tokenUsage.totalTokens,
            };
          },
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        )
      : undefined);
  if (!usage) return null;
  return { prompt: usage.promptTokens, completion: usage.completionTokens };
}

function computeAggregates(runs: Run[]): GroupAggregates {
  const turnValues = runs.map(getRunTurns).filter((v): v is number => v !== null);
  const durationValues = runs.map(getRunDuration).filter((v): v is number => v !== null);
  const tokenData = runs.map(getRunTokens).filter((v): v is { prompt: number; completion: number } => v !== null);

  return {
    count: runs.length,
    turns: computeStats(turnValues),
    duration: computeStats(durationValues),
    promptTokens: computeStats(tokenData.map((t) => t.prompt)),
    completionTokens: computeStats(tokenData.map((t) => t.completion)),
  };
}

export function groupRuns(runs: Run[], groupBy: GroupByKey): RunGroup[] {
  if (groupBy === "none") return [];

  const groups = new Map<string, Run[]>();

  for (const run of runs) {
    let key: string;
    if (groupBy === "task") {
      key = run.taskPromptId ?? run.scenario?.task ?? "unknown";
    } else {
      key = run.submissionId ?? "no-submission";
    }
    const list = groups.get(key);
    if (list) {
      list.push(run);
    } else {
      groups.set(key, [run]);
    }
  }

  const result: RunGroup[] = [];
  for (const [key, groupRuns] of groups) {
    let label: string;
    if (groupBy === "task") {
      label = groupRuns[0]?.scenario?.task ?? key;
    } else {
      label = key === "no-submission" ? "No submission ID" : key;
    }
    result.push({
      key,
      label,
      runs: groupRuns,
      aggregates: computeAggregates(groupRuns),
    });
  }

  return result;
}

export function formatStatRange(
  stat: AggregateStats | null,
  formatter: (v: number) => string = (v) => v.toLocaleString(),
): string {
  if (!stat) return "–";
  if (stat.min === stat.max) return formatter(stat.min);
  return `${formatter(stat.min)}–${formatter(stat.max)} (μ${formatter(Math.round(stat.mean * 10) / 10)}${stat.stdDev > 0 ? ` σ${formatter(Math.round(stat.stdDev * 10) / 10)}` : ""})`;
}
