// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from 'vitest';
import { collectClusterInputs, buildScenarioCriteriaMap } from './dedup.js';
import type { ParsedBenchmark, ScopeCriterion, ScopeLevel } from './types.js';
import type { DedupResult } from './dedup.js';

function makeParsed(
  name: string,
  criteriaInstructions: string[]
): ParsedBenchmark {
  const levels: ScopeLevel[] = [
    {
      name: 'L0',
      instruction: 'Build something.',
      metadata: { level: 'L0', type: 'Propensity' },
    },
  ];

  const criteria: ScopeCriterion[] = criteriaInstructions.map((inst, i) => ({
    name: `Propensity ${i + 1}: Test`,
    importance: 5 as const,
    instructions: inst,
    metadata: { type: 'Propensity' as const },
  }));

  return {
    benchmark: {
      id: `bench-${name}`,
      scenarioId: `scenario-${name}`,
      scenarioName: name,
      name: `test-${name}`,
    },
    scenario: {
      _id: `scenario-${name}`,
      name,
      levels,
      metadata: {},
    },
    criteria,
    criteriaByFile: { 'criteria-Propensity-1.json': criteria },
  };
}

describe('dedup', () => {
  describe('collectClusterInputs', () => {
    it('extracts checklist items from benchmarks', () => {
      const benchmarks = [
        makeParsed('Test App', [
          `<criteria>
- Uses Azure
  - skipped: N/A
  - passes: Azure configured
  - fails: No Azure
- Deploys to cloud
  - skipped: N/A
  - passes: Cloud deployed
  - fails: Not deployed
</criteria>`,
        ]),
      ];

      const inputs = collectClusterInputs(benchmarks);
      expect(inputs).toHaveLength(2);
      expect(inputs[0].scenarioSlug).toBe('test_app');
      expect(inputs[0].item.title).toBe('Uses Azure');
      expect(inputs[1].item.title).toBe('Deploys to cloud');
    });

    it('collects items across multiple benchmarks', () => {
      const benchmarks = [
        makeParsed('App A', [
          `<criteria>
- Item A1
  - skipped: N/A
  - passes: ok
  - fails: not ok
</criteria>`,
        ]),
        makeParsed('App B', [
          `<criteria>
- Item B1
  - skipped: N/A
  - passes: ok
  - fails: not ok
- Item B2
  - skipped: N/A
  - passes: ok
  - fails: not ok
</criteria>`,
        ]),
      ];

      const inputs = collectClusterInputs(benchmarks);
      expect(inputs).toHaveLength(3);
      expect(inputs[0].scenarioSlug).toBe('app_a');
      expect(inputs[1].scenarioSlug).toBe('app_b');
      expect(inputs[2].scenarioSlug).toBe('app_b');
    });

    it('skips non-checklist criteria', () => {
      const benchmarks = [
        makeParsed('App C', ['Plain procedural instructions without checklist format.']),
      ];

      const inputs = collectClusterInputs(benchmarks);
      expect(inputs).toHaveLength(0);
    });

    it('generates unique keys for each input', () => {
      const benchmarks = [
        makeParsed('App D', [
          `<criteria>
- Check A
  - skipped: N/A
  - passes: ok
  - fails: not ok
- Check B
  - skipped: N/A
  - passes: ok
  - fails: not ok
</criteria>`,
        ]),
      ];

      const inputs = collectClusterInputs(benchmarks);
      const keys = inputs.map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('buildScenarioCriteriaMap', () => {
    it('maps scenarios to their applicable canonical criterion IDs', () => {
      const benchmarks = [
        makeParsed('App X', ['dummy']),
        makeParsed('App Y', ['dummy']),
      ];

      const dedupResult: DedupResult = {
        criteria: new Map([
          [
            'uses_azure',
            {
              criterion: { id: 'uses_azure', prompt: 'test' },
              sourceScenarios: ['app_x', 'app_y'],
              sourceTitles: ['Uses Azure'],
              mergedCount: 2,
            },
          ],
          [
            'deploys_to_cloud',
            {
              criterion: { id: 'deploys_to_cloud', prompt: 'test' },
              sourceScenarios: ['app_x'],
              sourceTitles: ['Deploys to cloud'],
              mergedCount: 1,
            },
          ],
        ]),
        clusters: [],
        report: '',
        stats: { totalItems: 3, uniqueCriteria: 2, mergedItems: 2, clusterCount: 2 },
      };

      const map = buildScenarioCriteriaMap(benchmarks, dedupResult);

      expect(map.get('app_x')).toEqual(['uses_azure', 'deploys_to_cloud']);
      expect(map.get('app_y')).toEqual(['uses_azure']);
    });
  });
});
