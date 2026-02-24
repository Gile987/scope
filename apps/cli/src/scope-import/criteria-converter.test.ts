// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import {
  slugify,
  namespacedId,
  convertScopeCriterion,
  convertAllScopeCriteria,
  convertLevelDeltas,
  decomposeScopeCriterion,
  decomposeAllScopeCriteria,
  convertChecklistItem,
  buildChecklistPrompt,
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

  // ─── New decomposition functions ──────────────────────────────────────────

  describe('buildChecklistPrompt', () => {
    it('builds prompt from item with passes and fails', () => {
      const prompt = buildChecklistPrompt({
        title: 'Uses Azure AI services',
        skipped: '',
        passes: 'Azure AI service is configured and called',
        fails: 'No Azure AI service usage found',
      });
      expect(prompt).toContain('Evaluate whether the solution: Uses Azure AI services');
      expect(prompt).toContain('PASSES when: Azure AI service is configured and called');
      expect(prompt).toContain('FAILS when: No Azure AI service usage found');
    });

    it('omits passes/fails when null', () => {
      const prompt = buildChecklistPrompt({
        title: 'Simple check',
        skipped: '',
        passes: '',
        fails: '',
      });
      expect(prompt).toBe('Evaluate whether the solution: Simple check\n');
      expect(prompt).not.toContain('PASSES');
      expect(prompt).not.toContain('FAILS');
    });
  });

  describe('convertChecklistItem', () => {
    it('creates a criterion with intrinsic ID from item title', () => {
      const result = convertChecklistItem({
        title: 'Application uses Azure AI services',
        skipped: '',
        passes: 'Azure AI is used',
        fails: 'No Azure AI',
      });
      expect(result.id).toBe('application_uses_azure_ai_services');
      expect(result.prompt).toContain('Evaluate whether the solution:');
      expect(result.depends_on).toBeUndefined();
    });

    it('passes through depends_on', () => {
      const result = convertChecklistItem(
        { title: 'Test', skipped: '', passes: '', fails: '' },
        ['dep_a', 'dep_b']
      );
      expect(result.depends_on).toEqual(['dep_a', 'dep_b']);
    });

    it('omits empty depends_on', () => {
      const result = convertChecklistItem(
        { title: 'Test', skipped: '', passes: '', fails: '' },
        []
      );
      expect(result.depends_on).toBeUndefined();
    });
  });

  describe('decomposeScopeCriterion', () => {
    it('decomposes checklist-format criterion into multiple criteria', () => {
      const criterion: ScopeCriterion = {
        name: 'Propensity 1: Azure Services',
        importance: 5,
        instructions: `<criteria>
- Uses Azure AI
  - skipped: N/A
  - passes: Azure AI service is called
  - fails: No Azure AI usage
- Deploys to Azure
  - skipped: N/A
  - passes: Deployed to Azure
  - fails: Not deployed
</criteria>`,
        metadata: { type: 'Propensity' },
      };

      const results = decomposeScopeCriterion(criterion);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('uses_azure_ai');
      expect(results[0].prompt).toContain('PASSES when: Azure AI service is called');
      expect(results[1].id).toBe('deploys_to_azure');
    });

    it('falls back to full instructions for non-checklist criterion', () => {
      const criterion: ScopeCriterion = {
        name: 'Propensity 1: Uses Azure',
        importance: 5,
        instructions: 'Check that the application uses Azure services.',
        metadata: { type: 'Propensity' },
      };

      const results = decomposeScopeCriterion(criterion);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('uses_azure');
      expect(results[0].prompt).toBe('Check that the application uses Azure services.');
    });

    it('strips Propensity/Efficacy prefix from fallback name', () => {
      const criterion: ScopeCriterion = {
        name: 'Efficacy - Service Selection 1: Correct Services',
        importance: 3,
        instructions: 'Procedural instructions.',
        metadata: { type: 'Efficacy', level: 'L4' },
      };

      const results = decomposeScopeCriterion(criterion);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('correct_services');
    });

    it('passes depends_on to all items', () => {
      const criterion: ScopeCriterion = {
        name: 'Test',
        importance: 1,
        instructions: `<criteria>
- Item A
  - skipped: N/A
  - passes: ok
  - fails: not ok
- Item B
  - skipped: N/A
  - passes: ok
  - fails: not ok
</criteria>`,
        metadata: { type: 'Propensity' },
      };

      const results = decomposeScopeCriterion(criterion, ['dep1']);
      expect(results).toHaveLength(2);
      expect(results[0].depends_on).toEqual(['dep1']);
      expect(results[1].depends_on).toEqual(['dep1']);
    });
  });

  describe('decomposeAllScopeCriteria', () => {
    it('aggregates decomposed criteria across multiple SCOPE criteria', () => {
      const criteria: ScopeCriterion[] = [
        {
          name: 'Propensity 1: Azure',
          importance: 5,
          instructions: `<criteria>
- Uses Azure
  - skipped: N/A
  - passes: yes
  - fails: no
</criteria>`,
          metadata: { type: 'Propensity' },
        },
        {
          name: 'Efficacy 1: Compliance',
          importance: 3,
          instructions: 'Plain procedural check.',
          metadata: { type: 'Efficacy', level: 'L4' },
        },
      ];

      const results = decomposeAllScopeCriteria(criteria);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('uses_azure');
      expect(results[1].id).toBe('compliance');
    });
  });

  // ─── Legacy functions (kept for backward compat) ──────────────────────────

  describe('convertScopeCriterion (legacy)', () => {
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
      expect(result.prompt).toContain('[Efficacy (L5), Important]');
      expect(result.depends_on).toEqual(['dep1']);
    });
  });

  describe('convertAllScopeCriteria (legacy)', () => {
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

  describe('convertLevelDeltas (legacy)', () => {
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
