// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { normalizeCriteria } from './normalize-criteria.js';

describe('normalizeCriteria', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeCriteria([])).toEqual([]);
  });

  it('v2: returns CriteriaConfig[] as-is', () => {
    const criteria = [{ id: 'c1', prompt: 'Does it work?' }];
    expect(normalizeCriteria(criteria)).toBe(criteria);
  });

  it('v1: converts string array to CriteriaConfig[]', () => {
    const result = normalizeCriteria(['First check', 'Second check']);
    expect(result).toEqual([
      { id: 'criterion-1', prompt: 'First check', dependsOn: [] },
      { id: 'criterion-2', prompt: 'Second check', dependsOn: [] },
    ]);
  });

  it('v1: trims whitespace from prompt strings', () => {
    const result = normalizeCriteria(['  trimmed  ']);
    expect(result[0].prompt).toBe('trimmed');
  });

  it('v2: does not modify existing CriteriaConfig objects', () => {
    const criteria = [
      { id: 'c1', prompt: 'p1', dependsOn: ['c0'] },
      { id: 'c2', prompt: 'p2', dependsOn: [] },
    ];
    const result = normalizeCriteria(criteria);
    expect(result[0].dependsOn).toEqual(['c0']);
    expect(result[1].dependsOn).toEqual([]);
  });

  it('v1: assigns sequential ids starting from 1', () => {
    const result = normalizeCriteria(['a', 'b', 'c']);
    expect(result.map(c => c.id)).toEqual(['criterion-1', 'criterion-2', 'criterion-3']);
  });
});
