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
    function makeParsed(): ParsedBenchmark {
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
          instructions: 'Check Azure usage.',
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

    it('uses L0 instruction as task prompt', () => {
      const result = generateImport(makeParsed());
      expect(result.scenario.task).toBe('Build a web chat app.');
    });

    it('generates v2 scenario with criteria IDs', () => {
      const result = generateImport(makeParsed());
      expect(result.scenario.version).toBe('v2');
      expect(result.scenario.criteria).toContain(
        'test_web_chat_app_l1_delta'
      );
      // "Propensity 1: Uses Azure" → simplified "Uses Azure" → slug "uses_azure"
      expect(result.scenario.criteria).toContain(
        'test_web_chat_app_uses_azure'
      );
    });

    it('produces both level delta and SCOPE criteria', () => {
      const result = generateImport(makeParsed());
      expect(result.levelDeltaCriteria.length).toBeGreaterThan(0);
      expect(result.scopeCriteria.length).toBeGreaterThan(0);
      expect(result.criteria.length).toBe(
        result.levelDeltaCriteria.length + result.scopeCriteria.length
      );
    });

    it('sets the correct scenario slug', () => {
      const result = generateImport(makeParsed());
      expect(result.scenarioSlug).toBe('test_web_chat_app');
    });
  });
});
