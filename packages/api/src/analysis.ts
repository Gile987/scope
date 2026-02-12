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
}

// Run data needed for analysis (subset of RequestDocument)
export interface AnalyzableRun {
  scenario: { task: string };
  workerType: string;
  status: string;
  turns?: Array<{ iteration: number; passed: boolean }>;
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
 * Get the iteration count where a run passed (last turn's iteration if passed)
 */
function getPassedIteration(run: AnalyzableRun): number | null {
  if (!run.turns || run.turns.length === 0) return null;
  const lastTurn = run.turns[run.turns.length - 1];
  return lastTurn.passed ? lastTurn.iteration : null;
}

/**
 * Check if a run is considered "passed" (completed with final turn passed)
 */
function isPassedRun(run: AnalyzableRun): boolean {
  return getPassedIteration(run) !== null;
}

/**
 * Group runs by (task, workerType) and compute metrics
 */
export function computeAnalysis(runs: AnalyzableRun[], kValues: number[]): AnalysisResponse {
  // Group by task + workerType
  const groupMap = new Map<string, AnalyzableRun[]>();
  
  for (const run of runs) {
    const key = `${run.scenario.task}|||${run.workerType}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(run);
  }

  // Compute metrics for each group
  const groups: TaskWorkerGroup[] = [];
  let globalMaxT = 1;

  for (const [key, groupRuns] of groupMap) {
    const [task, workerType] = key.split('|||');
    
    const completed = groupRuns.filter(r => r.status === 'completed');
    const passedRuns = completed.filter(isPassedRun);
    const passedIterations = passedRuns
      .map(getPassedIteration)
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

    groups.push({
      task,
      workerType,
      total: groupRuns.length,
      completed: completed.length,
      passed: passedRuns.length,
      rejected: completed.length - passedRuns.length,
      passAtK,
      successAtT,
      iterationStats,
    });
  }

  // Now fill in Success@≤T for all groups using globalMaxT
  for (const group of groups) {
    const groupRuns = groupMap.get(`${group.task}|||${group.workerType}`)!;
    const passedRuns = groupRuns.filter(r => r.status === 'completed').filter(isPassedRun);
    const passedIterations = passedRuns
      .map(getPassedIteration)
      .filter((iter): iter is number => iter !== null);

    for (let t = 1; t <= globalMaxT; t++) {
      group.successAtT.push(calculateSuccessAtT(passedIterations, t));
    }
  }

  // Compute summary
  const allCompleted = runs.filter(r => r.status === 'completed');
  const allPassed = allCompleted.filter(isPassedRun);
  const allPassedIterations = allPassed
    .map(getPassedIteration)
    .filter((iter): iter is number => iter !== null);

  const summary = {
    totalRuns: runs.length,
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
  };
}
