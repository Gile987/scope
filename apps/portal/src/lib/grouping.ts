// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run, RunStatus } from "../types";

export type GroupByKey = "none" | "task" | "submissionId" | "profile";

export interface AggregateStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

export interface GroupUniformValues {
  workerType?: string;
  model?: string;
  agentVersion?: string;
  platform?: string;
  mcpServers?: string[];
  skillRevisions?: string[];
  status?: RunStatus;
  submissionId?: string;
  task?: string;
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
  uniform: GroupUniformValues;
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

function arrKey(arr: string[] | undefined): string {
  return (arr ?? []).slice().sort().join(",");
}

function uniform<T>(runs: Run[], getter: (r: Run) => T): T | undefined {
  if (runs.length === 0) return undefined;
  const first = getter(runs[0]);
  return runs.every((r) => getter(r) === first) ? first : undefined;
}

function computeUniformValues(runs: Run[]): GroupUniformValues {
  if (runs.length === 0) return {};

  const result: GroupUniformValues = {};

  const wt = uniform(runs, (r) => r.workerType);
  if (wt !== undefined) result.workerType = wt;

  const model = uniform(runs, (r) => r.model ?? "");
  if (model !== undefined && model !== "") result.model = model;

  const ver = uniform(runs, (r) => r.agentVersion ?? "");
  if (ver !== undefined && ver !== "") result.agentVersion = ver;

  const plat = uniform(runs, (r) => r.os?.platform ?? "");
  if (plat !== undefined && plat !== "") result.platform = plat;

  const status = uniform(runs, (r) => r.status);
  if (status !== undefined) result.status = status;

  const sub = uniform(runs, (r) => r.submissionId ?? "");
  if (sub !== undefined && sub !== "") result.submissionId = sub;

  const task = uniform(runs, (r) => r.scenario?.task ?? "");
  if (task !== undefined && task !== "") result.task = task;

  // Array fields: compare by sorted join
  const mcpKey = uniform(runs, (r) => arrKey(r.mcpServers));
  if (mcpKey !== undefined && mcpKey !== "") result.mcpServers = runs[0].mcpServers;

  const skillKey = uniform(runs, (r) => arrKey(r.skillRevisions));
  if (skillKey !== undefined && skillKey !== "") result.skillRevisions = runs[0].skillRevisions;

  return result;
}

export function groupRuns(runs: Run[], groupBy: GroupByKey): RunGroup[] {
  if (groupBy === "none") return [];

  const groups = new Map<string, Run[]>();

  for (const run of runs) {
    let key: string;
    if (groupBy === "task") {
      key = run.taskPromptId ?? run.scenario?.task ?? "unknown";
    } else if (groupBy === "profile") {
      key = run.profileId ?? "no-profile";
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
    } else if (groupBy === "profile") {
      label = key === "no-profile" ? "No profile" : key;
    } else {
      label = key === "no-submission" ? "No submission ID" : key;
    }
    result.push({
      key,
      label,
      runs: groupRuns,
      aggregates: computeAggregates(groupRuns),
      uniform: computeUniformValues(groupRuns),
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
