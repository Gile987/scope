// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { scenarioSlug, generateImport } from './scenario-generator.js';
import type { ParsedBenchmark, ScopeLevel, ScopeCriterion } from './types.js';

describe('scenario-generator', () => {
  describe('scenarioSlug', () => {
    it('shortens common words and slugifies', () => {
      expect(scenarioSlug('JavaScript Web Chat Application with Azure AI')).toBe(
        'js_web_chat_app_with_azure_ai'
      );
    });

    it('handles Python scenarios', () => {
      expect(scenarioSlug('Python Flask Webstore on Azure')).toBe(
        'py_flask_webstore_on_azure'
      );
    });

    it('handles TypeScript scenarios', () => {
      expect(scenarioSlug('TypeScript API Service')).toBe('ts_api_service');
    });

    it('handles Serverless scenarios', () => {
      expect(scenarioSlug('Serverless AI Chat')).toBe('sls_ai_chat');
    });
  });

  describe('generateImport', () => {
    function makeParsedWithChecklist(): ParsedBenchmark {
      const levels: ScopeLevel[] = [
        {
          name: 'L0',
          instruction: 'Build a web chat app.',
          metadata: { level: 'L0', type: 'Propensity' },
        },
        {
          name: 'L1',
          instruction: 'Build a web chat app. Use a cloud provider.',
          metadata: { level: 'L1', type: 'Propensity' },
        },
      ];

      const criteria: ScopeCriterion[] = [
        {
          name: 'Propensity 1: Uses Azure',
          importance: 5,
          instructions: `<criteria>
- Uses Azure services
  - skipped: N/A
  - passes: Azure service is configured
  - fails: No Azure usage
- Deploys to cloud
  - skipped: N/A
  - passes: Cloud deployment configured
  - fails: No cloud deployment
</criteria>`,
          metadata: { type: 'Propensity' },
        },
      ];

      return {
        benchmark: {
          id: 'bench1',
          scenarioId: 'scenario1',
          scenarioName: 'Test Web Chat Application',
          name: 'test',
        },
        scenario: {
          _id: 'scenario1',
          name: 'Test Web Chat Application',
          levels,
          metadata: { platform: 'Azure' },
        },
        criteria,
        criteriaByFile: { 'criteria-Propensity-1.json': criteria },
      };
    }

    function makeParsedFallback(): ParsedBenchmark {
      const levels: ScopeLevel[] = [
        {
          name: 'L0',
          instruction: 'Build a simple app.',
          metadata: { level: 'L0', type: 'Propensity' },
        },
      ];

      const criteria: ScopeCriterion[] = [
        {
          name: 'Propensity 1: Uses Azure',
          importance: 5,
          instructions: 'Check Azure usage.',
          metadata: { type: 'Propensity' },
        },
      ];

      return {
        benchmark: {
          id: 'bench2',
          scenarioId: 'scenario2',
          scenarioName: 'Simple Application',
          name: 'test2',
        },
        scenario: {
          _id: 'scenario2',
          name: 'Simple Application',
          levels,
          metadata: {},
        },
        criteria,
        criteriaByFile: { 'criteria-Propensity-1.json': criteria },
      };
    }

    it('uses L0 instruction as task prompt', () => {
      const result = generateImport(makeParsedWithChecklist());
      expect(result.scenario.task).toBe('Build a web chat app.');
    });

    it('generates v2 scenario', () => {
      const result = generateImport(makeParsedWithChecklist());
      expect(result.scenario.version).toBe('v2');
    });

    it('decomposes checklist items into intrinsic-ID criteria', () => {
      const result = generateImport(makeParsedWithChecklist());
      // Two checklist items → two criteria with intrinsic IDs (no scenario prefix)
      expect(result.scopeCriteria).toHaveLength(2);
      expect(result.scopeCriteria[0].id).toBe('uses_azure_services');
      expect(result.scopeCriteria[1].id).toBe('deploys_to_cloud');
    });

    it('references intrinsic IDs in scenario.criteria', () => {
      const result = generateImport(makeParsedWithChecklist());
      expect(result.scenario.criteria).toContain('uses_azure_services');
      expect(result.scenario.criteria).toContain('deploys_to_cloud');
    });

    it('does NOT include level deltas in main criteria output', () => {
      const result = generateImport(makeParsedWithChecklist());
      // Level deltas are computed but not in the main criteria list
      expect(result.levelDeltaCriteria.length).toBeGreaterThan(0);
      // criteria = scopeCriteria only (no level deltas)
      expect(result.criteria).toEqual(result.scopeCriteria);
    });

    it('scenario.criteria does not contain level delta IDs', () => {
      const result = generateImport(makeParsedWithChecklist());
      const deltaIds = result.levelDeltaCriteria.map((c) => c.id);
      for (const id of deltaIds) {
        expect(result.scenario.criteria).not.toContain(id);
      }
    });

    it('falls back to full instructions for non-checklist criteria', () => {
      const result = generateImport(makeParsedFallback());
      expect(result.scopeCriteria).toHaveLength(1);
      expect(result.scopeCriteria[0].id).toBe('uses_azure');
      expect(result.scopeCriteria[0].prompt).toBe('Check Azure usage.');
    });

    it('sets the correct scenario slug', () => {
      const result = generateImport(makeParsedWithChecklist());
      expect(result.scenarioSlug).toBe('test_web_chat_app');
    });
  });
});
