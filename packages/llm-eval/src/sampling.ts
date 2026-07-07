// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { withRateLimitRetry } from "./rate-limit.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strict-majority threshold for N samples: more than half, i.e. floor(N/2)+1. */
export function majority(sampleCount: number): number {
  return Math.floor(sampleCount / 2) + 1;
}

export interface SampledGradesOptions<Label> {
  /** How many times to generate + grade (each pair is one sample). */
  samples: number;
  /** Produce the artifact under test (e.g. a generated prompt). */
  generate: () => Promise<string>;
  /** Grade the artifact into a label. */
  grade: (artifact: string) => Promise<Label>;
  /** Delay between samples (default 6000ms) to respect the shared rate limit. */
  spacingMs?: number;
  /** Delay between a sample's generate and grade call (default 1500ms). */
  gradeSpacingMs?: number;
  /**
   * Wrap each LLM call for retry. Defaults to {@link withRateLimitRetry}
   * (429-only, exponential backoff). Pass `(fn) => fn()` to disable (e.g. tests).
   */
  retry?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Sample an LLM-graded eval `samples` times and return every grade in order.
 * Handles inter-call spacing and per-call rate-limit retry so callers only supply
 * `generate` + `grade` and assert on the returned labels (e.g. a majority).
 *
 * Each sample is one `generate` call followed by one `grade` call, so the total
 * LLM call count is `2 * samples` — size the spacing and the caller's rate budget
 * accordingly.
 */
export async function collectSampledGrades<Label>(
  options: SampledGradesOptions<Label>,
): Promise<Label[]> {
  const {
    samples,
    generate,
    grade,
    spacingMs = 6_000,
    gradeSpacingMs = 1_500,
    retry = withRateLimitRetry,
  } = options;

  const grades: Label[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0 && spacingMs > 0) await sleep(spacingMs);
    const artifact = await retry(() => generate());
    if (gradeSpacingMs > 0) await sleep(gradeSpacingMs);
    grades.push(await retry(() => grade(artifact)));
  }
  return grades;
}

/** Count how many grades equal `label`. */
export function countMatches<Label>(grades: Label[], label: Label): number {
  return grades.filter((grade) => grade === label).length;
}

/** True when a strict majority of `grades` equals `label`. */
export function isMajority<Label>(grades: Label[], label: Label): boolean {
  return countMatches(grades, label) >= majority(grades.length);
}
