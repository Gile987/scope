// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CriteriaConfig } from '../types/types.js';

/**
 * Normalize criteria from v1 format (string prompts) or v2 format (CriteriaConfig[])
 *
 * v1: Converts string array to CriteriaConfig[] with auto-generated IDs
 * v2: Returns as-is if already CriteriaConfig[]
 */
export function normalizeCriteria(
  criteria: string[] | CriteriaConfig[]
): CriteriaConfig[] {
  if (criteria.length === 0) {
    return [];
  }

  // Check if already normalized (CriteriaConfig[])
  if (typeof criteria[0] === 'object' && 'id' in criteria[0]) {
    return criteria as CriteriaConfig[];
  }

  // v1 format: convert strings to CriteriaConfig with auto IDs
  return (criteria as string[]).map((prompt, index) => ({
    id: `criterion-${index + 1}`,
    prompt: prompt.trim(),
    dependsOn: []
  }));
}
