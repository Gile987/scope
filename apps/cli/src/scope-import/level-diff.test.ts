// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import {
  normalizeWhitespace,
  extractDelta,
  extractAllDeltas,
  findOriginalSuffix,
} from './level-diff.js';
import type { ScopeLevel } from './types.js';

function makeLevel(
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
  type: 'Propensity' | 'Efficacy',
  instruction: string
): ScopeLevel {
  return {
    name: `Test ${level}`,
    instruction,
    metadata: { level, type },
  };
}

describe('level-diff', () => {
  describe('normalizeWhitespace', () => {
    it('collapses multiple spaces', () => {
      expect(normalizeWhitespace('hello   world')).toBe('hello world');
    });

    it('collapses newlines and tabs', () => {
      expect(normalizeWhitespace('hello\n\n  world\t!')).toBe('hello world !');
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeWhitespace('  hello  ')).toBe('hello');
    });
  });

  describe('findOriginalSuffix', () => {
    it('finds suffix when higher is lower + extra text', () => {
      const lower = 'Build an app.';
      const higher = 'Build an app. Use a cloud provider.';
      expect(findOriginalSuffix(lower, higher)).toBe('Use a cloud provider.');
    });

    it('handles multi-line with different whitespace', () => {
      const lower = 'Build an app.\nUse Node.js.';
      const higher = 'Build an app.\nUse Node.js.\n\nPrefer Microsoft technologies.';
      const suffix = findOriginalSuffix(lower, higher);
      expect(suffix).toBe('Prefer Microsoft technologies.');
    });
  });

  describe('extractDelta', () => {
    it('detects cumulative delta (L0 → L1)', () => {
      const l0 = makeLevel('L0', 'Propensity', 'Build an app. Use an LLM.');
      const l1 = makeLevel(
        'L1',
        'Propensity',
        'Build an app. Use an LLM. Consider using a major cloud provider.'
      );

      const delta = extractDelta(l0, l1);
      expect(delta.isCumulative).toBe(true);
      expect(delta.fromLevel).toBe('L0');
      expect(delta.toLevel).toBe('L1');
      expect(delta.addedText).toBe(
        'Consider using a major cloud provider.'
      );
    });

    it('detects full rewrite (L3 → L4)', () => {
      const l3 = makeLevel(
        'L3',
        'Propensity',
        'Build an app. Use an LLM. Consider cloud. Prefer Microsoft. Use Azure AI.'
      );
      const l4 = makeLevel(
        'L4',
        'Efficacy',
        'Build an app. You MUST deploy on Azure. Select services for hosting and LLM.'
      );

      const delta = extractDelta(l3, l4);
      expect(delta.isCumulative).toBe(false);
      expect(delta.fromLevel).toBe('L3');
      expect(delta.toLevel).toBe('L4');
      // Full rewrite: entire instruction returned
      expect(delta.addedText).toContain('You MUST deploy on Azure');
    });

    it('handles multi-line cumulative text with whitespace variations', () => {
      const l1 = makeLevel(
        'L1',
        'Propensity',
        'Build an app.\n\nUse an LLM.'
      );
      const l2 = makeLevel(
        'L2',
        'Propensity',
        'Build an app.\n\nUse an LLM.\n\nPrefer Microsoft technologies.'
      );

      const delta = extractDelta(l1, l2);
      expect(delta.isCumulative).toBe(true);
      expect(delta.addedText).toBe('Prefer Microsoft technologies.');
    });
  });

  describe('extractAllDeltas', () => {
    it('extracts propensity deltas L0→L1→L2→L3', () => {
      const levels: ScopeLevel[] = [
        makeLevel('L0', 'Propensity', 'Base prompt.'),
        makeLevel('L1', 'Propensity', 'Base prompt. Cloud hint.'),
        makeLevel('L2', 'Propensity', 'Base prompt. Cloud hint. Prefer Microsoft.'),
        makeLevel('L3', 'Propensity', 'Base prompt. Cloud hint. Prefer Microsoft. Use Azure AI.'),
      ];

      const deltas = extractAllDeltas(levels);
      expect(deltas).toHaveLength(3);
      expect(deltas[0].fromLevel).toBe('L0');
      expect(deltas[0].toLevel).toBe('L1');
      expect(deltas[1].fromLevel).toBe('L1');
      expect(deltas[1].toLevel).toBe('L2');
      expect(deltas[2].fromLevel).toBe('L2');
      expect(deltas[2].toLevel).toBe('L3');
    });

    it('extracts efficacy delta L4→L5', () => {
      const levels: ScopeLevel[] = [
        makeLevel('L4', 'Efficacy', 'Deploy on Azure.'),
        makeLevel('L5', 'Efficacy', 'Deploy on Azure. Use App Service, Key Vault, Managed Identity.'),
      ];

      const deltas = extractAllDeltas(levels);
      expect(deltas).toHaveLength(1);
      expect(deltas[0].fromLevel).toBe('L4');
      expect(deltas[0].toLevel).toBe('L5');
    });

    it('handles mixed propensity + efficacy levels', () => {
      const levels: ScopeLevel[] = [
        makeLevel('L0', 'Propensity', 'Base.'),
        makeLevel('L1', 'Propensity', 'Base. Cloud.'),
        makeLevel('L4', 'Efficacy', 'Must use Azure.'),
        makeLevel('L5', 'Efficacy', 'Must use Azure. App Service + Key Vault.'),
      ];

      const deltas = extractAllDeltas(levels);
      expect(deltas).toHaveLength(2);
      expect(deltas[0].toLevel).toBe('L1');
      expect(deltas[1].toLevel).toBe('L5');
    });

    it('returns empty for single level', () => {
      const levels: ScopeLevel[] = [
        makeLevel('L0', 'Propensity', 'Base.'),
      ];

      expect(extractAllDeltas(levels)).toHaveLength(0);
    });
  });
});
