// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * `llm-eval` — a small, transport-agnostic, **domain-agnostic** harness for
 * writing LLM-graded, sampled, majority-voted evals anywhere in the monorepo.
 *
 * It provides the reusable machinery, and nothing domain-specific:
 *   - {@link ChatComplete}: an injected transport so the harness never depends on
 *     a specific inference SDK or credential path.
 *   - a {@link collectSampledGrades} sampling harness (generic over the grade
 *     `Label`) plus {@link majority} / {@link isMajority} voting helpers.
 *   - {@link withRateLimitRetry}: an opt-in 429 backoff wrapper the LLM-calling
 *     functions (grader, generator) apply themselves — the sampler stays
 *     retry-agnostic so a deterministic grader isn't forced through it.
 *
 * Each eval supplies its own domain data (cases), its own grader (the label set
 * + grader prompt), and a `ChatComplete` adapter, then asserts on the returned
 * grades. For example, the api criteria-prompt orientation eval keeps its
 * evidence-source grader in `apps/api/src/criteria-prompt-eval-grader.eval.ts` and
 * feeds it to `collectSampledGrades` from here.
 */
export * from "./types.js";
export * from "./rate-limit.js";
export * from "./sampling.js";
