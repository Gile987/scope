// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ScanResult, ScannedModel } from "model-scanning";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

/**
 * Scan models available from the Anthropic API.
 *
 * Calls GET https://api.anthropic.com/v1/models and handles pagination.
 * Permissive: only validates the `id` field on each model, ignores unknown fields.
 */
export async function scanAnthropicModels(token: string): Promise<ScanResult> {
  const models: ScannedModel[] = [];
  let hasMore = true;
  let afterId: string | undefined;

  while (hasMore) {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set("limit", "100");
    if (afterId) {
      url.searchParams.set("after_id", afterId);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Anthropic models API returned HTTP ${response.status}: ${errorBody}`,
      );
    }

    const body = await response.json();

    // Permissive parsing: expect { data: [...], has_more: bool }
    const rawModels = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body)
        ? body
        : [];

    for (const m of rawModels) {
      if (!m || typeof m.id !== "string" || !m.id) continue;

      models.push({
        id: m.id,
        // Anthropic provides created_at as Unix timestamp
        ...(m.created_at
          ? {
              providerAvailableFrom: new Date(
                typeof m.created_at === "number"
                  ? m.created_at * 1000
                  : m.created_at,
              ),
            }
          : {}),
        // Capture display name and type as metadata
        ...(m.display_name || m.type
          ? {
              metadata: {
                ...(m.display_name ? { displayName: m.display_name } : {}),
                ...(m.type ? { type: m.type } : {}),
              },
            }
          : {}),
      });

      afterId = m.id;
    }

    // Check pagination
    hasMore = body?.has_more === true && rawModels.length > 0;
  }

  return {
    provider: "anthropic",
    models,
    scannedAt: new Date(),
  };
}
