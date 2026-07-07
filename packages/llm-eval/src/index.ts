// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * `llm-eval` — a small, transport-agnostic harness for writing LLM-graded,
 * sampled, majority-voted evals in the monorepo.
 *
 * It provides three pieces used together:
 *   - {@link ChatComplete}: an injected transport so the harness never depends on
 *     a specific inference SDK or credential path.
 *   - a {@link gradeEvidenceSource} LLM grader that judges which evidence source a
 *     generated judge-prompt makes primary (tool-call history vs codebase).
 *   - a {@link collectSampledGrades} sampling harness with rate-limit retry
 *     ({@link withRateLimitRetry}) and {@link majority} voting helpers.
 *
 * Callers (e.g. the api criteria-prompt orientation eval) supply the domain data
 * (cases) and a `ChatComplete` adapter, and assert on the returned grades.
 */
export * from "./types.js";
export * from "./rate-limit.js";
export * from "./grader.js";
export * from "./sampling.js";
