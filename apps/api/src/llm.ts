// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import ModelClient, { isUnexpected } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { isGitHubModelsTokenAvailable, acquireGitHubModelsToken } from "./llm-token.js";

const GITHUB_MODELS_ENDPOINT = "https://models.inference.ai.azure.com";

const SYSTEM_PROMPT = `You are an expert at writing evaluation criteria for AI coding agent benchmarks.

Given a natural-language description of a behavior or pattern to detect in a codebase, you must:

1. Write a concise evaluation prompt (1-3 sentences) that a judge LLM will use to decide whether a codebase exhibits that behavior. The prompt should be specific about what files, patterns, or configurations to look for. Keep it factual and objective.

2. Suggest a short, descriptive snake_case identifier for this criterion. The ID must:
   - Start with a lowercase letter
   - Contain only lowercase letters, digits, and underscores
   - Be concise but descriptive (e.g., has_unit_tests, uses_typescript, has_docker_config)

3. Suggest **parent dependencies** — existing criteria that should logically pass BEFORE this one can be evaluated. For example, if the new criterion checks for "Azure Functions", it likely depends on "has_azure" and "has_node" passing first. Only suggest IDs from the provided existing criteria list.

4. Suggest **children dependents** — existing criteria that should logically depend on this new criterion (i.e., this criterion should be a parent of those). For example, if the new criterion checks for "has_node", then "has_react" and "has_typescript" should depend on it. Only suggest IDs from the provided existing criteria list.

Here are examples of good criteria prompts:
- "The project uses Azure Bicep for infrastructure as code. Look for *.bicep files, bicepconfig.json, or main.bicep entry points."
- "The project uses React framework. Look for react dependency in package.json, .jsx or .tsx files with React components."
- "The project uses Node.js as its runtime environment. Look for package.json file or Node.js-specific configuration files."

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"prompt": "your evaluation prompt here", "suggestedId": "your_suggested_id", "suggestedParents": ["existing_id_1"], "suggestedChildren": ["existing_id_2"]}

If no parents or children are appropriate, use empty arrays.`;

export interface ExistingCriterion {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

export interface GenerateResult {
  prompt: string;
  suggestedId: string;
  suggestedParents: string[];
  suggestedChildren: string[];
}

export function isLlmAvailable(): boolean {
  return isGitHubModelsTokenAvailable();
}

function buildUserMessage(behavior: string, existingCriteria: ExistingCriterion[]): string {
  const parts: string[] = [];

  if (existingCriteria.length > 0) {
    parts.push("EXISTING CRITERIA (use only these IDs for parent/children suggestions):");
    for (const c of existingCriteria) {
      const deps = c.dependsOn?.length ? ` [parents: ${c.dependsOn.join(", ")}]` : "";
      parts.push(`- ${c.id}: ${c.prompt}${deps}`);
    }
    parts.push("");
  }

  parts.push(`NEW CRITERION TO CREATE:\n${behavior}`);
  return parts.join("\n");
}

export async function generateCriteriaPrompt(
  behavior: string,
  existingCriteria: ExistingCriterion[] = [],
  model?: string,
): Promise<GenerateResult> {
  const token = await acquireGitHubModelsToken();
  const llm = ModelClient(GITHUB_MODELS_ENDPOINT, new AzureKeyCredential(token));

  const modelName = model || process.env.LLM_MODEL || "gpt-4.1";
  const userMessage = buildUserMessage(behavior, existingCriteria);

  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      model: modelName,
      temperature: 0.3,
      max_tokens: 512,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as any;
    throw new Error(
      `LLM request failed: ${errBody?.error?.message || response.status}`,
    );
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  // Parse the JSON response, stripping any accidental markdown fences
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.prompt || !parsed.suggestedId) {
      throw new Error("Missing required fields");
    }
    // Sanitize the suggested ID
    const sanitizedId = parsed.suggestedId
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+/g, "_")
      .replace(/_$/, "");

    // Validate suggested deps against existing criteria IDs
    const existingIds = new Set(existingCriteria.map((c) => c.id));
    const suggestedParents = Array.isArray(parsed.suggestedParents)
      ? parsed.suggestedParents.filter((pid: string) => existingIds.has(pid))
      : [];
    const suggestedChildren = Array.isArray(parsed.suggestedChildren)
      ? parsed.suggestedChildren.filter((cid: string) => existingIds.has(cid))
      : [];

    return {
      prompt: parsed.prompt.trim(),
      suggestedId: sanitizedId || "new_criterion",
      suggestedParents,
      suggestedChildren,
    };
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`);
  }
}
