// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isUnexpected } from "@azure-rest/ai-inference";
import { gatesSatisfyInvariant, type GateId } from "shared";
import { acquireInferenceClient, isLlmAvailable as inferenceAvailable } from "./llm-token.js";

export type SuggestDirection = "parents" | "children";

/**
 * Authoring call: writes the evaluation prompt + suggests an id. This is the
 * orthogonal "write the criterion" concern — it never sees other criteria and
 * never suggests dependencies.
 */
const SYSTEM_PROMPT_AUTHOR = `You are an expert at writing evaluation criteria for AI coding agent benchmarks.

Given a natural-language description of a behavior or pattern to detect in a codebase, you must:

1. Write a concise evaluation prompt (1-3 sentences) that a judge LLM will use to decide whether a codebase exhibits that behavior. The prompt should be specific about what files, patterns, or configurations to look for. Keep it factual and objective.

2. Suggest a short, descriptive snake_case identifier for this criterion. The ID must:
   - Start with a lowercase letter
   - Contain only lowercase letters, digits, and underscores
   - Be concise but descriptive (e.g., has_unit_tests, uses_typescript, has_docker_config)

Here are examples of good criteria prompts:
- "The project uses Azure Bicep for infrastructure as code. Look for *.bicep files, bicepconfig.json, or main.bicep entry points."
- "The project uses React framework. Look for react dependency in package.json, .jsx or .tsx files with React components."
- "The project uses Node.js as its runtime environment. Look for package.json file or Node.js-specific configuration files."

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"prompt": "your evaluation prompt here", "suggestedId": "your_suggested_id"}`;

interface SuggestDirectionCopy {
  /** One-line definition of the relationship being asked for. */
  relationship: string;
  /** Concrete test the model must apply to each candidate before including it. */
  test: string;
  /** A positive example (a candidate that SHOULD be suggested) for this direction. */
  positiveExample: string;
  /** Heading used to label the candidate list in the user message. */
  candidatesHeading: string;
}

const DIRECTION_COPY: Record<SuggestDirection, SuggestDirectionCopy> = {
  parents: {
    relationship:
      "existing criteria that are genuine PREREQUISITES of the new criterion — i.e. the new criterion cannot be meaningfully evaluated unless that criterion already passes.",
    test: "Include a candidate ONLY if the new criterion is impossible or meaningless when that candidate fails.",
    positiveExample:
      'A new criterion "uses_express" (the Express web framework) genuinely depends on "has_node": Express is a Node.js library and cannot exist without Node, so has_node is a true prerequisite.',
    candidatesHeading: "CANDIDATE CRITERIA (use only these IDs):",
  },
  children: {
    relationship:
      "existing criteria for which the new criterion is a genuine PREREQUISITE — i.e. that criterion cannot be meaningfully evaluated unless the new criterion already passes.",
    test: "Include a candidate ONLY if that candidate is impossible or meaningless when the new criterion fails.",
    positiveExample:
      'A new criterion "has_node" is a genuine prerequisite of "uses_express": Express is a Node.js library and cannot exist without Node, so uses_express should depend on it.',
    candidatesHeading: "CANDIDATE CRITERIA (use only these IDs):",
  },
};

/**
 * Suggestion call (used symmetrically for parents and children): given the new
 * behavior and a pre-filtered candidate pool, returns the subset of candidates
 * that should be related to the new criterion in the given direction.
 */
function suggestSystemPrompt(direction: SuggestDirection): string {
  const { relationship, test, positiveExample } = DIRECTION_COPY[direction];
  return `You are an expert at organising evaluation criteria for AI coding agent benchmarks into a dependency graph.

A dependency edge A → B means "B cannot be meaningfully evaluated unless A passes first". Equivalently, B can never be true while A is false — B's truth REQUIRES A's truth. Only TRUE prerequisite relationships are edges. Two criteria that merely belong to the same topic or family are SIBLINGS, not a parent/child pair.

Given a natural-language description of a NEW criterion and a list of EXISTING criteria, suggest ${relationship}

${test}

INDEPENDENCE TEST (apply to every candidate): ask whether each criterion can be true or false irrespective of the other's outcome. If both can independently be true or false, they are INDEPENDENT — there is no dependency in either direction, so do not suggest the candidate. A dependency exists only when one criterion's truth would be impossible without the other's.

STRICT RULES:
- Do NOT suggest a candidate just because it is topically related, in the same family, or commonly seen together. Relatedness is not a dependency.
- Reject siblings and independent criteria. Example: "has_unit_tests" and "has_integration_tests" are both about testing, but each can be true or false regardless of the other — they are independent, so NEITHER should ever be suggested as a parent or child of the other.
- A real prerequisite is a hard requirement: if it fails, the dependent criterion is impossible or meaningless to assess.
- ${positiveExample}
- When in doubt, leave it out: prefer an empty array over a weak or speculative edge.

Only suggest IDs from the provided candidate list. If none are appropriate, return an empty array.

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"suggestions": ["existing_id_1", "existing_id_2"]}`;
}

export interface ExistingCriterion {
  id: string;
  prompt: string;
  dependsOn?: string[];
  gates?: GateId[];
}

export interface GenerateResult {
  prompt: string;
  suggestedId: string;
  suggestedParents: string[];
  suggestedChildren: string[];
}

export function isLlmAvailable(): boolean {
  return inferenceAvailable();
}

type ChatClient = Awaited<ReturnType<typeof acquireInferenceClient>>["client"];

function sanitizeId(suggestedId: unknown): string {
  if (typeof suggestedId !== "string") return "new_criterion";
  const sanitized = suggestedId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  return sanitized || "new_criterion";
}

function parseJson(content: string): any {
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`);
  }
}

async function chat(
  llm: ChatClient,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      model,
      temperature: 0.3,
      max_tokens: 512,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as any;
    throw new Error(`LLM request failed: ${errBody?.error?.message || response.status}`);
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }
  return content;
}

/**
 * The "write the criterion" call: prompt + id only. Failure throws — the prompt
 * is the one indispensable result of generation.
 */
async function author(
  llm: ChatClient,
  model: string,
  behavior: string,
): Promise<{ prompt: string; suggestedId: string }> {
  const content = await chat(llm, model, SYSTEM_PROMPT_AUTHOR, `NEW CRITERION TO CREATE:\n${behavior}`);
  const parsed = parseJson(content);
  if (!parsed.prompt) {
    throw new Error("Missing required field: prompt");
  }
  return {
    prompt: String(parsed.prompt).trim(),
    suggestedId: sanitizeId(parsed.suggestedId),
  };
}

function buildSuggestMessage(
  direction: SuggestDirection,
  behavior: string,
  pool: ExistingCriterion[],
): string {
  const parts: string[] = [];
  if (pool.length > 0) {
    parts.push(DIRECTION_COPY[direction].candidatesHeading);
    for (const c of pool) {
      const deps = c.dependsOn?.length ? ` [parents: ${c.dependsOn.join(", ")}]` : "";
      parts.push(`- ${c.id}: ${c.prompt}${deps}`);
    }
    parts.push("");
  }
  parts.push(`NEW CRITERION:\n${behavior}`);
  return parts.join("\n");
}

/**
 * Symmetric dependency-suggestion call. `parents` and `children` use this exact
 * path — only the pre-filtered `pool` and the directional wording differ. The
 * result is post-filtered against the pool's IDs so the model can never return a
 * candidate outside the gate-compatible set. Failure degrades to `[]` so a
 * suggestion hiccup never blocks criterion creation.
 */
async function suggestDeps(
  direction: SuggestDirection,
  llm: ChatClient,
  model: string,
  behavior: string,
  pool: ExistingCriterion[],
): Promise<string[]> {
  if (pool.length === 0) return [];
  const poolIds = new Set(pool.map((c) => c.id));
  try {
    const content = await chat(
      llm,
      model,
      suggestSystemPrompt(direction),
      buildSuggestMessage(direction, behavior, pool),
    );
    const parsed = parseJson(content);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return suggestions.filter((sid: unknown): sid is string => typeof sid === "string" && poolIds.has(sid));
  } catch (err) {
    console.warn(`[generate-prompt] ${direction} suggestion call failed, degrading to []:`, err);
    return [];
  }
}

/**
 * Generate a criterion's prompt and gate-aware parent/child suggestions.
 *
 * Issues three single-responsibility calls in parallel:
 *  - author      → {prompt, suggestedId}
 *  - suggestDeps("parents", parentPool)   → suggestedParents
 *  - suggestDeps("children", childPool)   → suggestedChildren
 *
 * The candidate pools are pre-filtered by the gate-compatibility invariant so no
 * gate wording is ever sent to the model: a parent must satisfy the invariant
 * over the new criterion's gates, and a child must have the new criterion as a
 * compatible parent. When `newGates` is omitted both pools are the full list
 * (backward compatible).
 */
export async function generateCriteriaPrompt(
  behavior: string,
  existingCriteria: ExistingCriterion[] = [],
  newGates?: GateId[],
  model?: string,
): Promise<GenerateResult> {
  const { client: llm, model: foundryModel } = await acquireInferenceClient();

  // Priority: explicit arg > key-specific (from Foundry blob) > env > default.
  const modelName = model || foundryModel || process.env.LLM_MODEL || "gpt-4.1";

  const parentPool = newGates
    ? existingCriteria.filter((c) => gatesSatisfyInvariant(c.gates, newGates))
    : existingCriteria;
  const childPool = newGates
    ? existingCriteria.filter((c) => gatesSatisfyInvariant(newGates, c.gates))
    : existingCriteria;

  const [authored, suggestedParents, suggestedChildren] = await Promise.all([
    author(llm, modelName, behavior),
    suggestDeps("parents", llm, modelName, behavior, parentPool),
    suggestDeps("children", llm, modelName, behavior, childPool),
  ]);

  return {
    prompt: authored.prompt,
    suggestedId: authored.suggestedId,
    suggestedParents,
    suggestedChildren,
  };
}
