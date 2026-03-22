// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { normalizeCriteria } from './normalize-criteria.js';

describe('normalizeCriteria', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeCriteria([])).toEqual([]);
  });

  it('converts v1 string array to CriteriaConfig[]', () => {
    const result = normalizeCriteria(['Check A', 'Check B']);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'criterion-1', prompt: 'Check A', dependsOn: [] });
    expect(result[1]).toMatchObject({ id: 'criterion-2', prompt: 'Check B', dependsOn: [] });
  });

  it('generates sequential ids starting at 1', () => {
    const result = normalizeCriteria(['x', 'y', 'z']);
    expect(result.map(c => c.id)).toEqual(['criterion-1', 'criterion-2', 'criterion-3']);
  });

  it('trims whitespace from v1 prompts', () => {
    const result = normalizeCriteria(['  hello  ', '\tworld\t']);
    expect(result[0].prompt).toBe('hello');
    expect(result[1].prompt).toBe('world');
  });

  it('passes v2 CriteriaConfig[] through unchanged', () => {
    const input = [
      { id: 'c1', prompt: 'Do X', dependsOn: [] },
      { id: 'c2', prompt: 'Do Y', dependsOn: ['c1'] },
    ];
    expect(normalizeCriteria(input)).toBe(input);
  });

  it('v2 passthrough preserves dependsOn relationships', () => {
    const input = [{ id: 'c1', prompt: 'Check', dependsOn: ['parent'] }];
    const result = normalizeCriteria(input);
    expect(result[0].dependsOn).toEqual(['parent']);
  });
});
