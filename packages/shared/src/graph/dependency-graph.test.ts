// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { DependencyGraph } from './dependency-graph.js';
import type { DependencyNode, DependencyResult } from './dependency-graph.js';

function node(id: string, dependsOn?: string[]): DependencyNode {
  return { id, ...(dependsOn ? { dependsOn } : {}) };
}

describe('DependencyGraph construction', () => {
  it('builds an empty graph', () => {
    const graph = new DependencyGraph([]);
    expect(graph.getAllNodes()).toHaveLength(0);
  });

  it('builds a graph with no dependencies', () => {
    const graph = new DependencyGraph([node('a'), node('b'), node('c')]);
    expect(graph.getAllNodes()).toHaveLength(3);
  });

  it('builds a linear chain', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(graph.getNode('a')).toBeDefined();
    expect(graph.getNode('b')).toBeDefined();
    expect(graph.getNode('c')).toBeDefined();
  });

  it('builds a diamond DAG', () => {
    const graph = new DependencyGraph([
      node('root'),
      node('left', ['root']),
      node('right', ['root']),
      node('bottom', ['left', 'right']),
    ]);
    expect(graph.getAllNodes()).toHaveLength(4);
  });

  it('throws on duplicate node id', () => {
    expect(() => new DependencyGraph([node('a'), node('a')])).toThrow("Duplicate node id 'a'");
  });

  it('throws on unknown dependency reference', () => {
    expect(() => new DependencyGraph([node('a', ['nonexistent'])])).toThrow(
      "Node 'a' depends on unknown node 'nonexistent'"
    );
  });

  it('throws on direct cycle', () => {
    expect(() => new DependencyGraph([node('a', ['b']), node('b', ['a'])])).toThrow(
      'Cycle detected in dependencies'
    );
  });

  it('throws on longer cycle', () => {
    expect(() =>
      new DependencyGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])])
    ).toThrow('Cycle detected in dependencies');
  });
});

describe('getNode / getAllNodes', () => {
  it('returns undefined for unknown id', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.getNode('unknown')).toBeUndefined();
  });

  it('returns the node for a known id', () => {
    const n = node('a');
    const graph = new DependencyGraph([n]);
    expect(graph.getNode('a')).toBe(n);
  });
});

describe('getAncestors', () => {
  it('returns empty set for a root node', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(graph.getAncestors('a').size).toBe(0);
  });

  it('returns immediate parent', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(graph.getAncestors('b')).toEqual(new Set(['a']));
  });

  it('returns transitive ancestors', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(graph.getAncestors('c')).toEqual(new Set(['a', 'b']));
  });

  it('deduplicates ancestors in a diamond', () => {
    const graph = new DependencyGraph([
      node('root'),
      node('left', ['root']),
      node('right', ['root']),
      node('bottom', ['left', 'right']),
    ]);
    expect(graph.getAncestors('bottom')).toEqual(new Set(['root', 'left', 'right']));
  });

  it('returns empty set for unknown id', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.getAncestors('unknown').size).toBe(0);
  });
});

describe('getDescendants', () => {
  it('returns empty set for a leaf node', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(graph.getDescendants('b').size).toBe(0);
  });

  it('returns immediate child', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(graph.getDescendants('a')).toEqual(new Set(['b']));
  });

  it('returns transitive descendants', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(graph.getDescendants('a')).toEqual(new Set(['b', 'c']));
  });

  it('returns empty set for unknown id', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.getDescendants('unknown').size).toBe(0);
  });
});

describe('topologicalSort', () => {
  it('returns single node unchanged', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.topologicalSort()).toEqual(['a']);
  });

  it('places parent before child in linear chain', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    const order = graph.topologicalSort();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('places root before both branches in diamond', () => {
    const graph = new DependencyGraph([
      node('root'),
      node('left', ['root']),
      node('right', ['root']),
      node('bottom', ['left', 'right']),
    ]);
    const order = graph.topologicalSort();
    expect(order.indexOf('root')).toBeLessThan(order.indexOf('left'));
    expect(order.indexOf('root')).toBeLessThan(order.indexOf('right'));
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('bottom'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('bottom'));
  });

  it('includes all nodes', () => {
    const graph = new DependencyGraph([node('a'), node('b'), node('c', ['a'])]);
    const order = graph.topologicalSort();
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('getRootFailures', () => {
  const graph = new DependencyGraph([
    node('root'),
    node('child', ['root']),
    node('leaf', ['child']),
    node('independent'),
  ]);

  it('returns nothing when all pass (CriterionResult format)', () => {
    const results = [
      { criterionId: 'root', passed: true },
      { criterionId: 'child', passed: true },
    ];
    expect(graph.getRootFailures(results)).toHaveLength(0);
  });

  it('returns root failure with no failing ancestors (CriterionResult format)', () => {
    const results = [
      { criterionId: 'root', passed: false },
      { criterionId: 'child', passed: false },
      { criterionId: 'leaf', passed: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('root');
  });

  it('returns only independent failure when root passes', () => {
    const results = [
      { criterionId: 'root', passed: true },
      { criterionId: 'independent', passed: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('independent');
  });

  it('returns nothing when all pass (PromptFeatureResult format)', () => {
    const results = [
      { featureId: 'root', detected: true },
      { featureId: 'child', detected: true },
    ];
    expect(graph.getRootFailures(results)).toHaveLength(0);
  });

  it('returns root failure (PromptFeatureResult format)', () => {
    const results = [
      { featureId: 'root', detected: false },
      { featureId: 'child', detected: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].featureId).toBe('root');
  });

  it('returns empty array for empty input', () => {
    expect(graph.getRootFailures([])).toHaveLength(0);
  });
});

describe('deprecated aliases', () => {
  it('getAllCriteria returns same as getAllNodes', () => {
    const nodes = [node('a'), node('b')];
    const graph = new DependencyGraph(nodes);
    expect(graph.getAllCriteria()).toEqual(graph.getAllNodes());
  });

  it('getCriterion returns same as getNode', () => {
    const n = node('a');
    const graph = new DependencyGraph([n]);
    expect(graph.getCriterion('a')).toBe(graph.getNode('a'));
    expect(graph.getCriterion('missing')).toBeUndefined();
  });
});
