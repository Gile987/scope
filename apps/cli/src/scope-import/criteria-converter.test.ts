// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import {
  slugify,
  namespacedId,
  convertScopeCriterion,
  convertAllScopeCriteria,
  convertLevelDeltas,
} from './criteria-converter.js';
import type { ScopeCriterion, ScopeLevel } from './types.js';

describe('criteria-converter', () => {
  describe('slugify', () => {
    it('converts to lowercase snake_case', () => {
      expect(slugify('Hello World')).toBe('hello_world');
    });

    it('strips special characters', () => {
      expect(slugify('Efficacy - Compliance 1: Required Services')).toBe(
        'efficacy_compliance_1_required_services'
      );
    });

    it('collapses multiple underscores', () => {
      expect(slugify('a---b___c')).toBe('a_b_c');
    });

    it('strips leading/trailing underscores', () => {
      expect(slugify('___test___')).toBe('test');
    });

    it('prefixes with c_ if starts with digit', () => {
      expect(slugify('123abc')).toBe('c_123abc');
    });

    it('handles empty string', () => {
      expect(slugify('')).toBe('');
    });
  });

  describe('namespacedId', () => {
    it('combines scenario slug and criterion slug', () => {
      expect(namespacedId('js_chat', 'uses_azure')).toBe('js_chat_uses_azure');
    });
  });

  describe('convertScopeCriterion', () => {
    it('converts a propensity criterion', () => {
      const criterion: ScopeCriterion = {
        name: 'Propensity 1: Application uses Azure AI services',
        importance: 5,
        instructions: '<criteria>\nCheck Azure AI usage\n</criteria>',
        metadata: { type: 'Propensity' },
      };

      const result = convertScopeCriterion(criterion, 'js_chat');
      expect(result.id).toBe('js_chat_application_uses_azure_ai_services');
      expect(result.prompt).toContain('[Propensity, Critical]');
      expect(result.prompt).toContain('Check Azure AI usage');
      expect(result.depends_on).toBeUndefined();
    });

    it('converts an efficacy criterion with dependencies', () => {
      const criterion: ScopeCriterion = {
        name: 'Efficacy - Service Selection 1: Correct Service Selection',
        importance: 3,
        instructions: 'Check service selection',
        metadata: { type: 'Efficacy', level: 'L5' },
      };

      const result = convertScopeCriterion(criterion, 'js_chat', ['dep1']);
      expect(result.id).toBe('js_chat_correct_service_selection');
      // Note: the regex strips 'Efficacy - Service Selection 1: ' prefix
      expect(result.prompt).toContain('[Efficacy (L5), Important]');
      expect(result.depends_on).toEqual(['dep1']);
    });
  });

  describe('convertAllScopeCriteria', () => {
    it('converts propensity and efficacy criteria with correct dependencies', () => {
      const criteria: ScopeCriterion[] = [
        {
          name: 'Propensity 1: Uses Azure',
          importance: 5,
          instructions: 'Check Azure',
          metadata: { type: 'Propensity' },
        },
        {
          name: 'Efficacy - Service Selection 1: Correct Selection',
          importance: 5,
          instructions: 'Check L4 selection',
          metadata: { type: 'Efficacy', level: 'L4' },
        },
        {
          name: 'Efficacy - Compliance 1: Required Services',
          importance: 5,
          instructions: 'Check L5 compliance',
          metadata: { type: 'Efficacy', level: 'L5' },
        },
      ];

      const results = convertAllScopeCriteria(criteria, 'test');
      expect(results).toHaveLength(3);

      // Propensity — no deps
      expect(results[0].depends_on).toBeUndefined();

      // Efficacy L4 — no deps
      expect(results[1].depends_on).toBeUndefined();

      // Efficacy L5 — depends on L4
      expect(results[2].depends_on).toEqual([results[1].id]);
    });
  });

  describe('convertLevelDeltas', () => {
    function makeLevel(
      level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5',
      type: 'Propensity' | 'Efficacy',
      instruction: string
    ): ScopeLevel {
      return { name: `Test ${level}`, instruction, metadata: { level, type } };
    }

    it('generates criteria from propensity deltas with dependency chain', () => {
      const levels = [
        makeLevel('L0', 'Propensity', 'Base.'),
        makeLevel('L1', 'Propensity', 'Base. Cloud hint.'),
        makeLevel('L2', 'Propensity', 'Base. Cloud hint. Prefer Microsoft.'),
      ];

      const results = convertLevelDeltas(levels, 'test');
      expect(results).toHaveLength(2);

      expect(results[0].id).toBe('test_l1_delta');
      expect(results[0].depends_on).toBeUndefined();

      expect(results[1].id).toBe('test_l2_delta');
      expect(results[1].depends_on).toEqual(['test_l1_delta']);
    });

    it('generates criteria from efficacy deltas', () => {
      const levels = [
        makeLevel('L4', 'Efficacy', 'Deploy on Azure.'),
        makeLevel('L5', 'Efficacy', 'Deploy on Azure. Use specific services.'),
      ];

      const results = convertLevelDeltas(levels, 'test');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test_l5_delta');
    });
  });
});
