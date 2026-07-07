// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Prompt-orientation eval for the criteria-prompt generator (issue #1225).
 *
 * `generateCriteriaPrompt` must steer the judge to the RIGHT evidence source for
 * each behavior:
 *   - agent-action behaviors (something the agent RAN or DID: a command, a
 *     bootstrap/scaffold, a tool/skill/MCP invocation) -> the captured tool-call
 *     history, which the judge can read via read_tool_outputs / get_tool_output.
 *   - structural behaviors (how the code is written) -> the codebase.
 *
 * This is an **eval**, not a unit test. Two layers of LLM are involved:
 *   1. Generation (the system under test): the REAL `generateCriteriaPrompt`
 *      against a real LLM (GitHub Models). Non-deterministic, so each case is
 *      sampled N times and asserted on a *majority*.
 *   2. Grading (an LLM judge): each generated prompt is classified by a second
 *      LLM call that decides which evidence source the prompt makes *primary*.
 *
 * The reusable eval framework — the LLM grader, the sampling/majority harness,
 * and the rate-limit retry — lives in the `llm-eval` package. This file supplies
 * only the api-specific pieces: the five production `rayfin_` cases and a
 * `ChatComplete` adapter around the api's inference client. It runs only under
 * `vitest.eval.config.ts` (`pnpm eval:criteria-prompts`) and self-skips when no
 * LLM token is available (same gate as the judge integration test).
 *
 * Overridable via env:
 *   - CRITERIA_EVAL_SAMPLES:      samples per case (default 5 local; CI sets 3).
 *   - CRITERIA_EVAL_MODEL:        generator model id (default gpt-4.1).
 *   - CRITERIA_EVAL_GRADER_MODEL: grader model id (default: the inference client's
 *                                 model, else gpt-4.1).
 * GitHub Models free tier is 15 req/60s; each sample makes 2 calls (generate +
 * grade), so calls are spaced and 429s retried with exponential backoff.
 */
import { describe, it, expect } from "vitest";
import { isUnexpected } from "@azure-rest/ai-inference";
import type { GateId } from "shared";
import {
  collectSampledGrades,
  gradeEvidenceSource,
  majority,
  type ChatComplete,
  type EvidenceGrade,
  type EvidenceSource,
} from "llm-eval";
import { generateCriteriaPrompt } from "./llm.js";
import { acquireInferenceClient, isLlmAvailable } from "./llm-token.js";

interface EvalCase {
  id: string;
  behavior: string;
  gates: GateId[];
  expect: EvidenceSource;
}

/**
 * The five production `rayfin_` criteria used to validate the #1225 fix. Two are
 * `select`-gated *agent-action* behaviors (bootstrap / skill+MCP) that are only
 * visible in the tool-call history; two are genuinely structural (judged from the
 * codebase); one is build-gated. Behavior strings are verbatim from the prod
 * criteria. Add new cases here to extend the guard.
 */
const CRITERIA_PROMPT_EVAL_CASES: EvalCase[] = [
  {
    id: "rayfin_app_builds",
    gates: ["select", "build"],
    behavior:
      "The Rayfin application builds successfully without any TypeScript errors",
    expect: "tool-history",
  },
  {
    id: "rayfin_app_has_been_setup",
    gates: ["select"],
    behavior:
      "The project is set up as a Rayfin app, with a rayfin/rayfin.yml config file and @microsoft/rayfin-* dependencies in package.json",
    expect: "codebase",
  },
  {
    id: "rayfin_bootstrap",
    gates: ["select"],
    behavior:
      "The Rayfin app was bootstrapped using the @microsoft/create-rayfin package via npx",
    expect: "tool-history",
  },
  {
    id: "rayfin_data_models",
    gates: ["select"],
    behavior:
      "The codebase defines Recipe and Favorite data models, both requiring authenticated access via the @authenticated('*') decorator",
    expect: "codebase",
  },
  {
    id: "rayfin_used_skill_and_mcp",
    gates: ["select"],
    behavior:
      "The project loads and uses the Rayfin skill and the Rayfin MCP server after bootstrapping",
    expect: "tool-history",
  },
];

const SAMPLES = Math.max(1, Number(process.env.CRITERIA_EVAL_SAMPLES ?? "5"));
const MODEL = process.env.CRITERIA_EVAL_MODEL || "gpt-4.1";
// Undefined unless explicitly overridden, so the adapter can fall back to the
// inference client's own model (foundry/token-manager path) before gpt-4.1.
const GRADER_MODEL = process.env.CRITERIA_EVAL_GRADER_MODEL;
const DEFAULT_MODEL = "gpt-4.1";
// Each sample makes TWO calls (generate + grade), so the free-tier 15 req/60s
// budget is hit twice as fast. Space samples generously; the framework's default
// rate-limit retry absorbs any transient 429 so a required check stays green.
const SPACING_MS = 6_000; // Between samples.
const GRADE_SPACING_MS = 1_500; // Between a sample's generate and grade call.

// Reuse a single inference client across all grader calls (same token path as
// the generator). Acquired lazily so the describe-level skip still short-circuits
// when no token is present.
let clientHandle: Awaited<ReturnType<typeof acquireInferenceClient>> | null = null;
async function inferenceClient() {
  if (!clientHandle) clientHandle = await acquireInferenceClient();
  return clientHandle;
}

/**
 * Adapt the api's GitHub Models / Azure inference client to the `llm-eval`
 * `ChatComplete` transport. This adapter stays in the test (not the package)
 * because it is api-specific: it depends on `acquireInferenceClient` and
 * `@azure-rest/ai-inference`, which the transport-agnostic package must not.
 */
const complete: ChatComplete = async ({ messages, model, temperature, maxTokens }) => {
  const { client, model: handleModel } = await inferenceClient();
  const response = await client.path("/chat/completions").post({
    body: {
      messages,
      model: model ?? handleModel ?? DEFAULT_MODEL,
      temperature,
      max_tokens: maxTokens,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as { error?: { message?: string } };
    throw new Error(
      `LLM request failed: ${errBody?.error?.message || response.status}`,
    );
  }
  return response.body.choices?.[0]?.message?.content ?? "";
};

describe.skipIf(!isLlmAvailable())(
  "criteria-prompt generator orientation (eval, #1225)",
  () => {
    it.each(CRITERIA_PROMPT_EVAL_CASES)(
      "$id ($expect): a majority of samples steer to the right evidence source",
      async ({ behavior, gates, expect: expected }) => {
        const grades = await collectSampledGrades<EvidenceGrade>({
          samples: SAMPLES,
          spacingMs: SPACING_MS,
          gradeSpacingMs: GRADE_SPACING_MS,
          generate: async () => {
            const { prompt } = await generateCriteriaPrompt(
              behavior,
              [],
              gates,
              MODEL,
            );
            return prompt;
          },
          grade: (prompt) =>
            gradeEvidenceSource(complete, prompt, { model: GRADER_MODEL }),
        });

        // Strict majority of N samples must be graded as the expected primary
        // evidence source. tool-history cases must cite the tool-call history;
        // codebase cases must stay codebase-oriented. "unclear" counts as a miss.
        const matches = grades.filter((g) => g === expected).length;
        const need = majority(SAMPLES);
        expect(
          matches,
          `expected >=${need}/${SAMPLES} prompts graded '${expected}', got ${matches} (grades: ${grades.join(", ")})`,
        ).toBeGreaterThanOrEqual(need);
      },
      300_000,
    );
  },
);
