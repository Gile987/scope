// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { normalizeCriteria } from './normalize-criteria.js';
import type { CriteriaConfig } from '../types/types.js';

describe('normalizeCriteria', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeCriteria([])).toEqual([]);
  });

  describe('v1 format (string[])', () => {
    it('converts a single string to CriteriaConfig with id criterion-1', () => {
      expect(normalizeCriteria(['Check code quality'])).toEqual([
        { id: 'criterion-1', prompt: 'Check code quality', dependsOn: [] },
      ]);
    });

    it('converts multiple strings with sequential ids', () => {
      const result = normalizeCriteria(['First', 'Second', 'Third']);
      expect(result.map(c => c.id)).toEqual(['criterion-1', 'criterion-2', 'criterion-3']);
    });

    it('trims whitespace from string prompts', () => {
      const result = normalizeCriteria(['  trimmed  ']);
      expect(result[0].prompt).toBe('trimmed');
    });

    it('initializes dependsOn to empty array', () => {
      const result = normalizeCriteria(['A', 'B']);
      expect(result[0].dependsOn).toEqual([]);
      expect(result[1].dependsOn).toEqual([]);
    });
  });

  describe('v2 format (CriteriaConfig[])', () => {
    it('passes through v2 array unchanged (identity)', () => {
      const input: CriteriaConfig[] = [
        { id: 'c1', prompt: 'Check A', dependsOn: [] },
        { id: 'c2', prompt: 'Check B', dependsOn: ['c1'] },
      ];
      const result = normalizeCriteria(input);
      expect(result).toBe(input);
    });

    it('preserves custom ids and dependency relationships', () => {
      const input: CriteriaConfig[] = [
        { id: 'my-id', prompt: 'My check', dependsOn: ['other'] },
      ];
      const result = normalizeCriteria(input);
      expect(result[0].id).toBe('my-id');
      expect(result[0].dependsOn).toEqual(['other']);
    });
  });
});
