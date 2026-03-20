// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { DependencyGraph } from './dependency-graph.js';
import type { DependencyNode, DependencyResult } from './dependency-graph.js';

// --- Helpers ---

function node(id: string, dependsOn?: string[]): DependencyNode {
  return { id, ...(dependsOn ? { dependsOn } : {}) };
}

// --- Tests ---

describe('DependencyGraph construction', () => {
  it('builds a graph with no dependencies', () => {
    const graph = new DependencyGraph([node('a'), node('b'), node('c')]);
    expect(graph.getAllNodes()).toHaveLength(3);
  });

  it('builds a linear chain', () => {
    const graph = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    expect(graph.getNode('a')).toBeDefined();
    expect(graph.getNode('c')).toBeDefined();
  });

  it('throws on duplicate node IDs', () => {
    expect(() =>
      new DependencyGraph([node('a'), node('a')])
    ).toThrow("Duplicate node id 'a'");
  });

  it('throws when depending on an unknown node', () => {
    expect(() =>
      new DependencyGraph([node('a', ['missing'])])
    ).toThrow("depends on unknown node 'missing'");
  });

  it('throws on a simple direct cycle (a -> a)', () => {
    expect(() =>
      new DependencyGraph([node('a', ['a'])])
    ).toThrow(/cycle|depends on unknown/i);
  });

  it('throws on an indirect cycle (a -> b -> a)', () => {
    // a depends on b, b depends on a — but we must list both before referencing
    // build a cycle: c depends on a, a depends on b, b depends on c
    expect(() =>
      new DependencyGraph([
        node('a', ['b']),
        node('b', ['c']),
        node('c', ['a']),
      ])
    ).toThrow(/cycle/i);
  });

  it('accepts an empty node list', () => {
    const graph = new DependencyGraph([]);
    expect(graph.getAllNodes()).toHaveLength(0);
  });
});

describe('DependencyGraph.getNode / getAllNodes', () => {
  it('returns undefined for unknown IDs', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.getNode('z')).toBeUndefined();
  });

  it('returns all nodes', () => {
    const graph = new DependencyGraph([node('x'), node('y')]);
    const ids = graph.getAllNodes().map(n => n.id).sort();
    expect(ids).toEqual(['x', 'y']);
  });
});

describe('DependencyGraph.getAncestors', () => {
  //  a <- b <- c <- d   (c depends on b, b depends on a, d depends on c)
  const graph = new DependencyGraph([
    node('a'),
    node('b', ['a']),
    node('c', ['b']),
    node('d', ['c']),
  ]);

  it('returns empty set for a root node (no parents)', () => {
    expect(graph.getAncestors('a').size).toBe(0);
  });

  it('returns immediate parent', () => {
    expect(graph.getAncestors('b')).toEqual(new Set(['a']));
  });

  it('returns all transitive ancestors', () => {
    expect(graph.getAncestors('d')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns empty set for an unknown node ID', () => {
    expect(graph.getAncestors('unknown').size).toBe(0);
  });
});

describe('DependencyGraph.getDescendants', () => {
  //  a <- b <- c   (b depends on a, c depends on b)
  const graph = new DependencyGraph([
    node('a'),
    node('b', ['a']),
    node('c', ['b']),
  ]);

  it('returns all transitive descendants', () => {
    expect(graph.getDescendants('a')).toEqual(new Set(['b', 'c']));
  });

  it('returns immediate child', () => {
    expect(graph.getDescendants('b')).toEqual(new Set(['c']));
  });

  it('returns empty set for a leaf node', () => {
    expect(graph.getDescendants('c').size).toBe(0);
  });

  it('returns empty set for an unknown node ID', () => {
    expect(graph.getDescendants('unknown').size).toBe(0);
  });
});

describe('DependencyGraph.topologicalSort', () => {
  it('orders parents before their dependents', () => {
    const graph = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    const order = graph.topologicalSort();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('handles nodes with no dependencies in any order', () => {
    const graph = new DependencyGraph([node('x'), node('y'), node('z')]);
    const order = graph.topologicalSort();
    expect(new Set(order)).toEqual(new Set(['x', 'y', 'z']));
    expect(order).toHaveLength(3);
  });

  it('handles a diamond dependency (a <- b, a <- c, b+c <- d)', () => {
    const graph = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    const order = graph.topologicalSort();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('returns all nodes', () => {
    const graph = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(graph.topologicalSort()).toHaveLength(2);
  });

  it('returns empty array for empty graph', () => {
    const graph = new DependencyGraph([]);
    expect(graph.topologicalSort()).toEqual([]);
  });
});

describe('DependencyGraph.getRootFailures', () => {
  // Graph: a <- b <- c   (b depends on a, c depends on b)
  const graph = new DependencyGraph([
    node('a'),
    node('b', ['a']),
    node('c', ['b']),
  ]);

  it('returns the single root failure when a root node fails', () => {
    const results: DependencyResult[] = [
      { criterionId: 'a', passed: false },
      { criterionId: 'b', passed: false },
      { criterionId: 'c', passed: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('a');
  });

  it('returns only downstream root when ancestor passes', () => {
    const results: DependencyResult[] = [
      { criterionId: 'a', passed: true },
      { criterionId: 'b', passed: false },
      { criterionId: 'c', passed: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('b');
  });

  it('returns empty array when all pass', () => {
    const results: DependencyResult[] = [
      { criterionId: 'a', passed: true },
      { criterionId: 'b', passed: true },
      { criterionId: 'c', passed: true },
    ];
    expect(graph.getRootFailures(results)).toHaveLength(0);
  });

  it('returns all independent failures in disconnected cases', () => {
    const g = new DependencyGraph([node('x'), node('y')]);
    const results: DependencyResult[] = [
      { criterionId: 'x', passed: false },
      { criterionId: 'y', passed: false },
    ];
    const roots = g.getRootFailures(results);
    expect(roots).toHaveLength(2);
  });

  it('works with featureId/detected format', () => {
    const results: DependencyResult[] = [
      { featureId: 'a', detected: false },
      { featureId: 'b', detected: false },
      { featureId: 'c', detected: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].featureId).toBe('a');
  });

  it('treats passed===undefined as not-failed', () => {
    const results: DependencyResult[] = [
      { criterionId: 'a' },   // no passed/detected → not failed
      { criterionId: 'b', passed: false },
    ];
    const roots = graph.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('b');
  });
});

describe('DependencyGraph deprecated aliases', () => {
  it('getAllCriteria() returns same as getAllNodes()', () => {
    const graph = new DependencyGraph([node('a'), node('b')]);
    expect(graph.getAllCriteria()).toEqual(graph.getAllNodes());
  });

  it('getCriterion() returns same as getNode()', () => {
    const graph = new DependencyGraph([node('a')]);
    expect(graph.getCriterion('a')).toEqual(graph.getNode('a'));
    expect(graph.getCriterion('z')).toBeUndefined();
  });
});
