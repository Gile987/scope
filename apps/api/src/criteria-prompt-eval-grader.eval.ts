// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Evidence-source grader for the criteria-prompt orientation eval (issue #1225).
 *
 * Domain-specific to the api's criteria-prompt generator, so it lives beside its
 * consumer (`llm.eval.test.ts`), NOT in the generic `llm-eval` package. The
 * package provides only reusable, domain-agnostic machinery (the `ChatComplete`
 * transport, rate-limit retry, and the sampling/majority harness); each eval
 * brings its own grader like this one.
 *
 * The grader answers a single yes/no question — "does this generated judge-prompt
 * make the case's EXPECTED evidence source the primary basis for the verdict?" —
 * and returns a plain `boolean` (pass/fail). It deliberately does NOT emit a
 * multi-way classification: the eval only needs to know whether each sample
 * passes, and a boolean keeps the sampling/majority math trivial.
 */
import { withRateLimitRetry, type ChatComplete } from "llm-eval";

/**
 * The evidence source a criterion's judge-prompt should make PRIMARY. This is the
 * per-case ground truth the grader checks against — not something the grader
 * returns (it returns pass/fail):
 *   - "tool-history": the agent's captured tool-call history (commands/tools run,
 *     with stdout/stderr, exit status, logs) — the ONLY place actions that leave
 *     no lasting file trace are visible.
 *   - "codebase": the resulting source files on disk.
 */
export type EvidenceSource = "tool-history" | "codebase";

/** How each source is described to the grader inside the rubric. */
const SOURCE_RUBRIC: Record<EvidenceSource, string> = {
  "tool-history":
    "the agent's CAPTURED TOOL-CALL HISTORY — the commands and tools it ran, with their stdout/stderr, exit status, and logs (the only place actions that leave no lasting file trace, such as running a command or bootstrapping/scaffolding a project or invoking a skill or MCP server, are visible)",
  codebase: "the RESULTING SOURCE FILES on disk (the codebase)",
};

export interface GradeOptions {
  /** Grader model id; forwarded to the injected `ChatComplete`. */
  model?: string;
  /** Defaults to 0 so the grader reads emphasis deterministically. */
  temperature?: number;
  /** Defaults to 20 — the reply is a tiny JSON object. */
  maxTokens?: number;
  /**
   * Wraps the single grading LLM call so transient 429s are retried with
   * exponential backoff. Defaults to {@link withRateLimitRetry}. Retry lives here,
   * on the grader, because the grader is the thing that makes the LLM call — it
   * owns its transient-failure handling rather than relying on the caller or the
   * sampling harness (a deterministic grader would simply not set this). Pass
   * `(fn) => fn()` to disable.
   */
  retry?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Build the grader system prompt for a given expected primary source. The grader
 * is told which source is correct for this behavior and asked whether the prompt
 * makes THAT source primary — so it judges emphasis/primacy, not mere keyword
 * presence (a prompt that lists both sources but leads with the wrong one fails).
 */
export function buildEvidenceGraderSystem(expected: EvidenceSource): string {
  return `You are grading an INSTRUCTION PROMPT that will be handed to an automated evaluator (the "judge") to decide whether a coding agent achieved a specific behavior while completing a task.

The judge can draw on two evidence sources: the agent's captured tool-call history (the commands and tools it ran, with their stdout/stderr, exit status, and logs) and the resulting source files on disk.

For THIS behavior a correct instruction prompt must direct the judge to treat ${SOURCE_RUBRIC[expected]} as the PRIMARY basis for the verdict. It may mention the other source, but it must not lead with or emphasize it.

Answer PASS only if the prompt below clearly makes ${SOURCE_RUBRIC[expected]} the primary evidence. Answer FAIL if it leads with or emphasizes the other source, or gives neither source primacy.

Respond with ONLY a compact JSON object and nothing else: {"pass":true} or {"pass":false}.`;
}

/**
 * Parse the grader's raw reply into a pass/fail boolean. Strips ```json fences,
 * reads the JSON `pass` field (boolean or "true"/"pass"/"yes" string), and falls
 * back to sniffing the raw text. Anything unrecognized (including an ambiguous
 * reply that mentions both pass and fail) is treated as FAIL, so a malformed or
 * hedging grade never counts as a pass. Exported for deterministic unit tests.
 */
export function parsePassFail(content: string): boolean {
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const pass = (JSON.parse(cleaned) as { pass?: unknown })?.pass;
    if (typeof pass === "boolean") return pass;
    if (typeof pass === "string") return /^(true|pass|yes)$/i.test(pass.trim());
  } catch {
    // Not clean JSON — fall through to a conservative text sniff.
  }
  const saysPass = /\b(pass|true|yes)\b/i.test(content);
  const saysFail = /\b(fail|false|no)\b/i.test(content);
  return saysPass && !saysFail;
}

/**
 * LLM grader: returns whether the instruction prompt makes `expected` the primary
 * evidence source (pass) or not (fail). Uses a second LLM call at temperature 0
 * so it reads emphasis/primacy rather than mere keyword presence. The LLM
 * transport is injected via `complete`, and the call is wrapped in a rate-limit
 * retry (its own responsibility, since it is the code making the LLM call).
 */
export async function gradeCriteriaPrompt(
  complete: ChatComplete,
  promptText: string,
  expected: EvidenceSource,
  options: GradeOptions = {},
): Promise<boolean> {
  const { retry = withRateLimitRetry } = options;
  const content = await retry(() =>
    complete({
      messages: [
        { role: "system", content: buildEvidenceGraderSystem(expected) },
        { role: "user", content: promptText },
      ],
      model: options.model,
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 20,
    }),
  );
  return parsePassFail(content);
}
