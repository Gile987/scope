// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
  /** Delay between samples (default 6000ms) to respect a shared rate limit. */
  spacingMs?: number;
  /** Delay between a sample's generate and grade call (default 1500ms). */
  gradeSpacingMs?: number;
}

/**
 * Sample an eval `samples` times and return every grade in order. This harness
 * only orchestrates the loop and the inter-call spacing — it is deliberately
 * retry-agnostic. Retrying transient failures (e.g. 429s) is the job of whatever
 * actually makes an LLM call, so `generate` and `grade` own that themselves
 * (wrap them in {@link withRateLimitRetry} when they hit a rate-limited service).
 * This keeps a deterministic grader from being dragged through a backoff wrapper
 * it never needs.
 *
 * Each sample is one `generate` call followed by one `grade` call, so the total
 * call count is `2 * samples` — size the spacing and the caller's rate budget
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
  } = options;

  const grades: Label[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0 && spacingMs > 0) await sleep(spacingMs);
    const artifact = await generate();
    if (gradeSpacingMs > 0) await sleep(gradeSpacingMs);
    grades.push(await grade(artifact));
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
