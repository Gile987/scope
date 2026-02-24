// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { cosineSimilarity, clusterByEmbedding, generateDedupReport } from './embedding-cluster.js';
import type { ClusterInput } from './embedding-cluster.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('handles normalized vectors', () => {
    const a = [0.6, 0.8];
    const b = [0.8, 0.6];
    const expected = 0.6 * 0.8 + 0.8 * 0.6; // 0.96
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected);
  });

  it('returns 0 for zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('Vector length mismatch');
  });
});

describe('clusterByEmbedding', () => {
  function makeInput(key: string, scenario: string, title: string): ClusterInput {
    return {
      key,
      scenarioSlug: scenario,
      criterionName: `criterion_${key}`,
      item: { title, skipped: 'never', passes: 'passes', fails: 'fails' },
    };
  }

  it('clusters identical vectors together', () => {
    const inputs: ClusterInput[] = [
      makeInput('a', 'scenario1', 'Uses Key Vault'),
      makeInput('b', 'scenario2', 'Uses Key Vault'),
      makeInput('c', 'scenario3', 'Uses Cosmos DB'),
    ];
    const embeddings = new Map<string, number[]>([
      ['a', [1, 0, 0]],
      ['b', [1, 0, 0]],
      ['c', [0, 1, 0]],
    ]);

    const clusters = clusterByEmbedding(inputs, embeddings, 0.9);

    // Should have 2 clusters: {a,b} and {c}
    expect(clusters).toHaveLength(2);

    const multiMember = clusters.find((c) => c.members.length === 2);
    expect(multiMember).toBeDefined();
    const keys = multiMember!.members.map((m) => m.input.key).sort();
    expect(keys).toEqual(['a', 'b']);
  });

  it('keeps dissimilar items as singletons', () => {
    const inputs: ClusterInput[] = [
      makeInput('a', 's1', 'A'),
      makeInput('b', 's2', 'B'),
      makeInput('c', 's3', 'C'),
    ];
    const embeddings = new Map<string, number[]>([
      ['a', [1, 0, 0]],
      ['b', [0, 1, 0]],
      ['c', [0, 0, 1]],
    ]);

    const clusters = clusterByEmbedding(inputs, embeddings, 0.8);
    expect(clusters).toHaveLength(3);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it('respects similarity threshold', () => {
    const inputs: ClusterInput[] = [
      makeInput('a', 's1', 'A'),
      makeInput('b', 's2', 'B'),
    ];
    // cos(a, b) ≈ 0.8
    const a = [0.6, 0.8];
    const b = [0.8, 0.6];
    const embeddings = new Map<string, number[]>([
      ['a', a],
      ['b', b],
    ]);

    // threshold 0.9 → separate
    const highThreshold = clusterByEmbedding(inputs, embeddings, 0.97);
    expect(highThreshold).toHaveLength(2);

    // threshold 0.5 → together
    const lowThreshold = clusterByEmbedding(inputs, embeddings, 0.5);
    expect(lowThreshold).toHaveLength(1);
  });

  it('sorts multi-member clusters before singletons', () => {
    const inputs: ClusterInput[] = [
      makeInput('a', 's1', 'Singleton'),
      makeInput('b', 's2', 'Pair 1'),
      makeInput('c', 's3', 'Pair 2'),
    ];
    const embeddings = new Map<string, number[]>([
      ['a', [0, 0, 1]],
      ['b', [1, 0, 0]],
      ['c', [1, 0, 0]],
    ]);

    const clusters = clusterByEmbedding(inputs, embeddings, 0.9);
    expect(clusters[0].members.length).toBe(2);
    expect(clusters[1].members.length).toBe(1);
  });
});

describe('generateDedupReport', () => {
  it('generates markdown with cluster stats', () => {
    const report = generateDedupReport([
      {
        id: 0,
        representativeTitle: 'Uses Key Vault',
        avgSimilarity: 0.95,
        members: [
          {
            input: {
              key: 'a',
              scenarioSlug: 's1',
              criterionName: 'c1',
              item: { title: 'Uses Key Vault', skipped: '', passes: '', fails: '' },
            },
            similarityToCentroid: 0.98,
          },
          {
            input: {
              key: 'b',
              scenarioSlug: 's2',
              criterionName: 'c2',
              item: { title: 'Key Vault secrets', skipped: '', passes: '', fails: '' },
            },
            similarityToCentroid: 0.92,
          },
        ],
      },
      {
        id: 1,
        representativeTitle: 'Unique item',
        avgSimilarity: 1.0,
        members: [
          {
            input: {
              key: 'c',
              scenarioSlug: 's3',
              criterionName: 'c3',
              item: { title: 'Unique item', skipped: '', passes: '', fails: '' },
            },
            similarityToCentroid: 1.0,
          },
        ],
      },
    ]);

    expect(report).toContain('# SCOPE Criteria Deduplication Report');
    expect(report).toContain('Clusters with 2+ members: 1');
    expect(report).toContain('Singleton items: 1');
    expect(report).toContain('Potential dedup savings: 1 items');
    expect(report).toContain('Uses Key Vault');
    expect(report).toContain('Key Vault secrets');
    expect(report).toContain('0.950');
  });
});
