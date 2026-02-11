// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import ModelClient, { isUnexpected } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";

const GITHUB_MODELS_ENDPOINT = "https://models.inference.ai.azure.com";

const SYSTEM_PROMPT = `You are an expert at writing evaluation criteria for AI coding agent benchmarks.

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

let client: ReturnType<typeof ModelClient> | null = null;

function getClient(): ReturnType<typeof ModelClient> | null {
  if (client) return client;
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  client = ModelClient(GITHUB_MODELS_ENDPOINT, new AzureKeyCredential(token));
  return client;
}

export function isLlmAvailable(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

export async function generateCriteriaPrompt(
  behavior: string,
  model?: string,
): Promise<{ prompt: string; suggestedId: string }> {
  const llm = getClient();
  if (!llm) {
    throw new Error("LLM not configured: GITHUB_TOKEN is not set");
  }

  const modelName = model || process.env.LLM_MODEL || "gpt-4.1";

  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: behavior },
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

    return {
      prompt: parsed.prompt.trim(),
      suggestedId: sanitizedId || "new_criterion",
    };
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`);
  }
}
