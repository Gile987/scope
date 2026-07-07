// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatComplete } from "./types.js";

/**
 * The two evidence sources every agent run exposes to the judge:
 *   - "tool-history": the agent's captured tool-call history (commands/tools run,
 *     with stdout/stderr, exit status, logs) — the ONLY place actions that leave
 *     no lasting file trace are visible.
 *   - "codebase": the resulting source files on disk.
 */
export type EvidenceSource = "tool-history" | "codebase";

/** A grade is an evidence source, or "unclear" when neither is made primary. */
export type EvidenceGrade = EvidenceSource | "unclear";

export const EVIDENCE_SOURCE_GRADER_SYSTEM = `You are grading an INSTRUCTION PROMPT that will be handed to an automated evaluator (the "judge"). The judge must decide whether a coding agent achieved a specific behavior while completing a task.

Every agent run exposes two evidence sources:
- "tool-history": the agent's captured tool-call history — the commands and tools it ran, with their captured stdout/stderr, exit status, and execution logs. This is the ONLY place actions that leave no lasting file trace are visible (running a command, bootstrapping or scaffolding a project, invoking a skill or an MCP server).
- "codebase": the resulting source files on disk — used to judge how the code is written or structured.

Read the instruction prompt and decide which evidence source it directs the judge to treat as the PRIMARY basis for the verdict. If the prompt clearly leads with or emphasizes one source, choose that one even if the other is also mentioned. Only answer "unclear" if it genuinely gives neither source primacy.

Respond with ONLY a compact JSON object and nothing else: {"source":"tool-history"} or {"source":"codebase"} or {"source":"unclear"}.`;

export interface GradeEvidenceSourceOptions {
  /** Grader model id; forwarded to the injected `ChatComplete`. */
  model?: string;
  /** Defaults to 0 so the grader reads emphasis deterministically. */
  temperature?: number;
  /** Defaults to 20 — the reply is a tiny JSON object. */
  maxTokens?: number;
}

/**
 * Parse the grader's raw reply into an {@link EvidenceGrade}. Strips ```json
 * fences, parses the JSON `source`, and falls back to sniffing the raw text when
 * the model doesn't return clean JSON. Exported so the parse logic can be
 * unit-tested deterministically without an LLM.
 */
export function parseEvidenceGrade(content: string): EvidenceGrade {
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  let source: unknown;
  try {
    source = (JSON.parse(cleaned) as { source?: unknown })?.source;
  } catch {
    if (/tool[- ]?history/i.test(content)) source = "tool-history";
    else if (/codebase/i.test(content)) source = "codebase";
  }
  return source === "tool-history" || source === "codebase" ? source : "unclear";
}

/**
 * LLM grader: given an instruction prompt destined for the judge, classify which
 * evidence source it makes PRIMARY (tool-call history vs codebase). Uses a second
 * LLM call (temperature 0) so it reads emphasis/primacy rather than mere keyword
 * presence — a prompt that lists both sources but leads with the wrong one is
 * scored correctly. The LLM transport is injected via `complete`.
 */
export async function gradeEvidenceSource(
  complete: ChatComplete,
  promptText: string,
  options: GradeEvidenceSourceOptions = {},
): Promise<EvidenceGrade> {
  const content = await complete({
    messages: [
      { role: "system", content: EVIDENCE_SOURCE_GRADER_SYSTEM },
      { role: "user", content: promptText },
    ],
    model: options.model,
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 20,
  });
  return parseEvidenceGrade(content);
}
