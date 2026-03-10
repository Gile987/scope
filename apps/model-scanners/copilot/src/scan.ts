// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ScanResult } from "model-scanning";

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

/**
 * Scan models available from the GitHub Copilot API.
 *
 * Calls GET https://api.githubcopilot.com/models and parses the response.
 * Permissive: only validates the `id` field on each model, ignores unknown fields.
 *
 * @see https://aider.chat/docs/llms/github.html
 */
export async function scanCopilotModels(token: string): Promise<ScanResult> {
  const response = await fetch(COPILOT_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    throw new Error(
      `Copilot models API returned HTTP ${response.status}: ${errorBody}`,
    );
  }

  const body = await response.json();

  // Permissive parsing: expect { data: [...] } but handle variations
  const rawModels = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];

  const models = rawModels
    .filter(
      (m: Record<string, unknown>) => m && typeof m.id === "string" && m.id,
    )
    .map((m: Record<string, unknown>) => ({
      id: m.id as string,
      // Extract availability/EOL dates if the API provides them
      ...(m.created_at
        ? { providerAvailableFrom: new Date(m.created_at as string) }
        : {}),
      ...(m.deprecation_date || m.end_of_life
        ? {
            providerEndOfLife: new Date(
              (m.deprecation_date || m.end_of_life) as string,
            ),
          }
        : {}),
      // Keep a subset of useful metadata
      ...(m.name || m.version
        ? {
            metadata: {
              ...(m.name ? { name: m.name } : {}),
              ...(m.version ? { version: m.version } : {}),
            },
          }
        : {}),
    }));

  return {
    provider: "github-copilot",
    models,
    scannedAt: new Date(),
  };
}
