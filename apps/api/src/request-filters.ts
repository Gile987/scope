// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Utilities for building MongoDB filter objects for the /api/v1/requests endpoint.
 * Extracted for testability.
 */

/**
 * Parse a comma-separated string of IDs into a trimmed, non-empty array.
 * Returns an empty array if the input is falsy or contains only whitespace.
 */
export function parseCommaSeparatedIds(input: string | undefined | null): string[] {
  if (!input) return [];
  return input.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Build a MongoDB filter clause for scenario.criteria containing ALL given IDs.
 * Returns undefined if no IDs are provided.
 */
export function buildScenarioCriteriaFilter(ids: string[]): Record<string, unknown> | undefined {
  if (ids.length === 0) return undefined;
  return { "scenario.criteria": { $all: ids } };
}

/**
 * Build a MongoDB $and clause to match task prompts that have ALL given
 * prompt features detected (featureId + detected: true).
 * Returns undefined if no feature IDs are provided.
 */
export function buildPromptFeatureTaskPromptFilter(featureIds: string[]): Record<string, unknown> | undefined {
  if (featureIds.length === 0) return undefined;
  return {
    $and: featureIds.map(fid => ({
      features: {
        $elemMatch: { featureId: fid, detected: true },
      },
    })),
    deletedAt: { $exists: false },
  };
}
