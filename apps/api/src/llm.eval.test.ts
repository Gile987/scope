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
 * This is an **eval**, not a unit test: it calls the REAL generator against a
 * real LLM (GitHub Models), so it is non-deterministic and asserted on a
 * *majority* of N samples rather than a single deterministic output. It runs
 * only under `vitest.eval.config.ts` (`pnpm eval:criteria-prompts`) and
 * self-skips when no LLM token is available (same gate as the judge integration
 * test). It guards against regressions like the inert first fix for #1225, where
 * the `select`-gate hint steered agent-action criteria to files-only and dropped
 * the tool-call history the judge actually has.
 *
 * Overridable via env:
 *   - CRITERIA_EVAL_SAMPLES: samples per case (default 5 local; CI sets 3).
 *   - CRITERIA_EVAL_MODEL:   model id (default gpt-4.1).
 * GitHub Models free tier is 15 req/60s, so calls are spaced and 429s retried
 * with exponential backoff.
 */
import { describe, it, expect } from "vitest";
import { withRetry, type GateId } from "shared";
import { generateCriteriaPrompt } from "./llm.js";
import { isLlmAvailable } from "./llm-token.js";

type EvidenceSource = "tool-history" | "codebase";

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

/**
 * True if the generated prompt tells the judge to consult the agent's captured
 * tool-call history / command output. Deterministic classifier (no second LLM
 * layer): validated against the real generated prompts with no false negatives.
 */
export function mentionsToolCallHistory(prompt: string): boolean {
  return /tool[- ]?call|tool[- ]?calling|tool output|captured (?:tool|command|output)|command(?:'s)? output|exit status|output history|execution (?:log|history)|terminal output|\blogs?\b|history of (?:tool|command|the agent)/i.test(
    prompt,
  );
}

const SAMPLES = Math.max(1, Number(process.env.CRITERIA_EVAL_SAMPLES ?? "5"));
const MODEL = process.env.CRITERIA_EVAL_MODEL || "gpt-4.1";
const SPACING_MS = 4_500; // GitHub Models free tier: 15 req/60s per user-model.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry only on rate-limit errors; real orientation failures must surface. */
function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate limit|too many requests/i.test(msg);
}

describe.skipIf(!isLlmAvailable())(
  "criteria-prompt generator orientation (eval, #1225)",
  () => {
    it.each(CRITERIA_PROMPT_EVAL_CASES)(
      "$id ($expect): a majority of samples steer to the right evidence source",
      async ({ behavior, gates, expect: expected }) => {
        let hits = 0;
        for (let i = 0; i < SAMPLES; i++) {
          if (i > 0) await sleep(SPACING_MS);
          const { prompt } = await withRetry(
            () => generateCriteriaPrompt(behavior, [], gates, MODEL),
            {
              maxRetries: 5,
              baseDelayMs: 5_000,
              maxDelayMs: 60_000,
              isRetryable: isRateLimit,
            },
          );
          if (mentionsToolCallHistory(prompt)) hits++;
        }

        // Strict majority of N. tool-history cases must cite the tool-call
        // history in most samples; codebase cases must NOT (they stay
        // files-oriented) in most samples.
        const majority = Math.ceil(SAMPLES / 2);
        if (expected === "tool-history") {
          expect(
            hits,
            `expected >=${majority}/${SAMPLES} prompts to cite the tool-call history, got ${hits}`,
          ).toBeGreaterThanOrEqual(majority);
        } else {
          expect(
            hits,
            `expected <=${SAMPLES - majority}/${SAMPLES} prompts to cite the tool-call history (codebase-oriented), got ${hits}`,
          ).toBeLessThan(majority);
        }
      },
      300_000,
    );
  },
);
