// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Analysis module for computing benchmark metrics
 * 
 * Provides pass@k, success@≤T, and iteration statistics for runs
 * grouped by task and worker type.
 */

// Types for analysis response
export interface TaskWorkerGroup {
  task: string;
  taskPromptId: string;
  workerType: string;
  total: number;
  completed: number;
  passed: number;
  rejected: number;
  passAtK: Record<number, number>;  // k -> probability
  successAtT: number[];  // CDF: index i = probability of success at ≤(i+1) iterations
  iterationStats: {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
  } | null;  // null if no passed runs
  durationStats: {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
  } | null;  // Total run duration in ms (null if no timing data)
}

export interface AnalysisResponse {
  groups: TaskWorkerGroup[];
  kValues: number[];
  maxT: number;
  summary: {
    totalRuns: number;
    completedRuns: number;
    passedRuns: number;
    overallPassRate: number;
    avgIterationsToPass: number | null;
  };
  /** Union of all criteria IDs found across all runs (before filtering) */
  availableCriteria: string[];
  /** Criteria IDs that were used to define success (empty = use turn.passed) */
  selectedCriteria: string[];
  /** Union of all detected task-prompt feature IDs across all runs (before filtering) */
  availableFeatures: string[];
  /** Task-prompt feature IDs used to filter runs (empty = no feature filter) */
  selectedFeatures: string[];
  /**
   * True when the analyzed run set was capped to a most-recent-N window to bound
   * memory (see ANALYSIS_MAX_RUNS). Older runs are excluded from the metrics;
   * the portal surfaces this as a banner. Absent/false = the full set was analyzed.
   */
  truncated?: boolean;
  /** The configured run cap (max runs analyzed) — only meaningful when `truncated`. */
  runLimit?: number;
}

/** Per-criterion result stored on each turn */
export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;
}

import { computeTaskPromptId } from 'shared';

// Run data needed for analysis (subset of RequestDocument)
export interface AnalyzableRun {
  scenario: { task: string; criteria?: string[] };
  taskPromptId?: string;
  /** Detected/evaluated features of this run's task prompt (for feature filtering) */
  promptFeatures?: Array<{ featureId: string; detected: boolean }>;
  workerType: string;
  status: string;
  outcome?: string;
  turns?: Array<{
    iteration: number;
    passed: boolean;
    criteriaResults?: CriterionResult[];
    durationMs?: number;
  }>;
}

/**
 * Calculate pass@k metric using the unbiased estimator
 * pass@k = 1 - C(n-c, k) / C(n, k)
 * 
 * Where:
 * - n = total number of samples
 * - c = number of correct (valid) samples
 * - k = number of samples to consider
 */
export function calculatePassAtK(n: number, c: number, k: number): number {
  if (n < k) return c > 0 ? 1.0 : 0.0;
  if (c === 0) return 0.0;
  if (c >= n) return 1.0;

  // Calculate using logarithms to avoid overflow
  // C(n-c, k) / C(n, k) = product((n-c-i)/(n-i)) for i in 0..k-1
  let ratio = 1.0;
  for (let i = 0; i < k; i++) {
    ratio *= (n - c - i) / (n - i);
  }
  return 1.0 - ratio;
}

/**
 * Calculate success@≤T: the probability that the run completes successfully at t ≤ T
 * 
 * This is a CDF (Cumulative Distribution Function) metric that shows the
 * probability of successful completion within T iterations.
 * 
 * @param passedIterations - Array of iteration counts for passed runs
 * @param T - Maximum number of iterations to consider
 * @returns Probability (0-1) of completion within T iterations
 */
export function calculateSuccessAtT(passedIterations: number[], T: number): number {
  if (passedIterations.length === 0) return 0;
  const completedByT = passedIterations.filter(iter => iter <= T).length;
  return completedByT / passedIterations.length;
}

/**
 * Calculate standard deviation of an array of numbers
 */
function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Check if a turn is considered passed based on selected criteria.
 * If selectedCriteria is empty or undefined, uses turn.passed.
 * Otherwise:
 *   - If turn.passed is true, all criteria passed, so any subset also passed
 *   - If turn.passed is false, check if the selected subset specifically passed
 */
function isTurnPassed(
  turn: { passed: boolean; criteriaResults?: CriterionResult[] },
  selectedCriteria?: string[]
): boolean {
  if (!selectedCriteria || selectedCriteria.length === 0) {
    return turn.passed;
  }
  // If the turn passed overall, all criteria passed, so any subset also passed
  if (turn.passed) {
    return true;
  }
  // Turn didn't pass overall - check if the selected criteria subset passed
  if (!turn.criteriaResults) {
    return false;
  }
  const resultsMap = new Map(turn.criteriaResults.map(r => [r.criterionId, r]));
  return selectedCriteria.every(id => resultsMap.get(id)?.passed === true);
}

/**
 * Get the iteration count where a run passed (last turn's iteration if passed)
 * @param selectedCriteria - If provided, determines pass based on these criteria
 */
function getPassedIteration(run: AnalyzableRun, selectedCriteria?: string[]): number | null {
  if (!run.turns || run.turns.length === 0) return null;
  const lastTurn = run.turns[run.turns.length - 1];
  return isTurnPassed(lastTurn, selectedCriteria) ? lastTurn.iteration : null;
}

/**
 * Check if a run is considered "passed" (completed with final turn passed)
 */
function isPassedRun(run: AnalyzableRun, selectedCriteria?: string[]): boolean {
  return getPassedIteration(run, selectedCriteria) !== null;
}

/**
 * Cap a run list to a maximum size, reporting whether truncation occurred.
 *
 * The analysis endpoint fetches the most-recent `max + 1` runs so it can detect
 * "there are more than `max`" in a single query; this helper trims back to `max`
 * and flags truncation. Bounding the in-memory run set is what keeps the analysis
 * pass from loading an unbounded number of documents.
 */
export function capRunsToLimit<T>(runs: T[], max: number): { runs: T[]; truncated: boolean } {
  if (runs.length <= max) return { runs, truncated: false };
  return { runs: runs.slice(0, max), truncated: true };
}

/**
 * Group runs by (task, workerType) and compute metrics
 * @param runs - All runs to analyze
 * @param kValues - Values of k for pass@k calculation
 * @param selectedCriteria - If provided, filter to runs containing these criteria and use them to define success
 */
export function computeAnalysis(
  runs: AnalyzableRun[],
  kValues: number[],
  selectedCriteria?: string[],
  selectedFeatures?: string[]
): AnalysisResponse {
  // Filter out runs without a valid scenario
  const allValidRuns = runs.filter(run => run.scenario?.task);
  
  // Collect all available criteria from all runs (before filtering)
  const availableCriteriaSet = new Set<string>();
  for (const run of allValidRuns) {
    if (run.scenario.criteria) {
      for (const c of run.scenario.criteria) {
        availableCriteriaSet.add(c);
      }
    }
  }
  const availableCriteria = Array.from(availableCriteriaSet).sort();

  // Collect all detected task-prompt feature IDs from all runs (before filtering).
  // Only detected===true counts: a task prompt stores a row for every evaluated
  // feature (detected:true|false), so presence alone is not meaningful.
  const availableFeaturesSet = new Set<string>();
  for (const run of allValidRuns) {
    if (run.promptFeatures) {
      for (const f of run.promptFeatures) {
        if (f.detected) availableFeaturesSet.add(f.featureId);
      }
    }
  }
  const availableFeatures = Array.from(availableFeaturesSet).sort();

  // Filter runs: if selectedCriteria is provided, only include runs that have ALL selected criteria
  const criteriaFilteredRuns = selectedCriteria && selectedCriteria.length > 0
    ? allValidRuns.filter(run => {
        const runCriteria = new Set(run.scenario.criteria || []);
        return selectedCriteria.every(c => runCriteria.has(c));
      })
    : allValidRuns;

  // Further filter by selected task-prompt features (AND: keep a run only if its
  // task prompt has every selected feature detected===true).
  const validRuns = selectedFeatures && selectedFeatures.length > 0
    ? criteriaFilteredRuns.filter(run => {
        const detected = new Set(
          (run.promptFeatures || []).filter(f => f.detected).map(f => f.featureId)
        );
        return selectedFeatures.every(f => detected.has(f));
      })
    : criteriaFilteredRuns;
  
  // Group by taskPromptId + workerType (falls back to computing ID from text for legacy runs)
  const groupMap = new Map<string, AnalyzableRun[]>();
  
  for (const run of validRuns) {
    const tpId = run.taskPromptId || computeTaskPromptId(run.scenario.task);
    const key = `${tpId}|||${run.workerType}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(run);
  }

  // Compute metrics for each group
  const groups: TaskWorkerGroup[] = [];
  let globalMaxT = 1;

  for (const [key, groupRuns] of groupMap) {
    const [taskPromptId, workerType] = key.split('|||');
    const task = groupRuns[0].scenario.task;  // Use task text from first run in group
    
    const completed = groupRuns.filter(r => r.status === 'done');
    const passedRuns = completed.filter(r => r.outcome === 'succeeded' && isPassedRun(r, selectedCriteria));
    const passedIterations = passedRuns
      .map(r => getPassedIteration(r, selectedCriteria))
      .filter((iter): iter is number => iter !== null);

    const maxIterInGroup = passedIterations.length > 0
      ? Math.max(...passedIterations)
      : 1;
    globalMaxT = Math.max(globalMaxT, maxIterInGroup);

    // Pass@k calculations
    const n = completed.length;
    const c = passedRuns.length;
    const passAtK: Record<number, number> = {};
    for (const k of kValues) {
      passAtK[k] = calculatePassAtK(n, c, k);
    }

    // Success@≤T CDF (will be filled after we know globalMaxT)
    // For now, store the passed iterations for later
    const successAtT: number[] = [];

    // Iteration stats for passed runs
    let iterationStats: TaskWorkerGroup['iterationStats'] = null;
    if (passedIterations.length > 0) {
      const mean = passedIterations.reduce((a, b) => a + b, 0) / passedIterations.length;
      iterationStats = {
        mean,
        stdDev: stdDev(passedIterations),
        min: Math.min(...passedIterations),
        max: Math.max(...passedIterations),
      };
    }

    // Duration stats: total run duration (sum of iteration durations) across passed runs
    let durationStats: TaskWorkerGroup['durationStats'] = null;
    const runDurations = passedRuns
      .map(r => {
        const turns = r.turns || [];
        const turnDurations = turns.map(t => t.durationMs).filter((d): d is number => d != null);
        return turnDurations.length > 0 ? turnDurations.reduce((a, b) => a + b, 0) : null;
      })
      .filter((d): d is number => d != null);
    if (runDurations.length > 0) {
      const mean = runDurations.reduce((a, b) => a + b, 0) / runDurations.length;
      durationStats = {
        mean,
        stdDev: stdDev(runDurations),
        min: Math.min(...runDurations),
        max: Math.max(...runDurations),
      };
    }

    groups.push({
      task,
      taskPromptId,
      workerType,
      total: groupRuns.length,
      completed: completed.length,
      passed: passedRuns.length,
      rejected: completed.length - passedRuns.length,
      passAtK,
      successAtT,
      iterationStats,
      durationStats,
    });
  }

  // Now fill in Success@≤T for all groups using globalMaxT
  for (const group of groups) {
    const tpId = group.taskPromptId;
    const groupRuns = groupMap.get(`${tpId}|||${group.workerType}`)!;
    const passedRuns = groupRuns.filter(r => r.status === 'done' && r.outcome === 'succeeded').filter(r => isPassedRun(r, selectedCriteria));
    const passedIterations = passedRuns
      .map(r => getPassedIteration(r, selectedCriteria))
      .filter((iter): iter is number => iter !== null);

    for (let t = 1; t <= globalMaxT; t++) {
      group.successAtT.push(calculateSuccessAtT(passedIterations, t));
    }
  }

  // Compute summary
  const allCompleted = validRuns.filter(r => r.status === 'done');
  const allPassed = allCompleted.filter(r => r.outcome === 'succeeded' && isPassedRun(r, selectedCriteria));
  const allPassedIterations = allPassed
    .map(r => getPassedIteration(r, selectedCriteria))
    .filter((iter): iter is number => iter !== null);

  const summary = {
    totalRuns: validRuns.length,
    completedRuns: allCompleted.length,
    passedRuns: allPassed.length,
    overallPassRate: allCompleted.length > 0 ? allPassed.length / allCompleted.length : 0,
    avgIterationsToPass: allPassedIterations.length > 0
      ? allPassedIterations.reduce((a, b) => a + b, 0) / allPassedIterations.length
      : null,
  };

  return {
    groups,
    kValues,
    maxT: globalMaxT,
    summary,
    availableCriteria,
    selectedCriteria: selectedCriteria || [],
    availableFeatures,
    selectedFeatures: selectedFeatures || [],
  };
}
