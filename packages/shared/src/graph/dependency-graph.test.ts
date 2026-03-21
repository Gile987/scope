// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { DependencyGraph, DependencyNode } from './dependency-graph.js';

// Minimal node factory
const node = (id: string, dependsOn: string[] = []): DependencyNode => ({ id, dependsOn });

describe('DependencyGraph construction', () => {
  it('builds an empty graph', () => {
    const g = new DependencyGraph([]);
    expect(g.getAllNodes()).toHaveLength(0);
  });

  it('builds a single-node graph', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getNode('a')).toEqual({ id: 'a', dependsOn: [] });
  });

  it('builds a linear chain a → b → c', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(g.getAllNodes()).toHaveLength(3);
  });

  it('builds a diamond: a → b, a → c, b → d, c → d', () => {
    const g = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    expect(g.getAllNodes()).toHaveLength(4);
  });

  it('throws on duplicate node ids', () => {
    expect(() => new DependencyGraph([node('a'), node('a')])).toThrow("Duplicate node id 'a'");
  });

  it('throws when a node depends on an unknown id', () => {
    expect(() => new DependencyGraph([node('b', ['missing'])])).toThrow(
      "Node 'b' depends on unknown node 'missing'"
    );
  });

  it('throws on a direct cycle (a → b, b → a)', () => {
    expect(() =>
      new DependencyGraph([node('a', ['b']), node('b', ['a'])])
    ).toThrow('Cycle detected in dependencies');
  });

  it('throws on a self-loop (a → a)', () => {
    expect(() => new DependencyGraph([node('a', ['a'])])).toThrow();
  });

  it('throws on a longer cycle (a → b → c → a)', () => {
    expect(() =>
      new DependencyGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])])
    ).toThrow('Cycle detected in dependencies');
  });
});

describe('DependencyGraph.getAncestors', () => {
  it('returns empty set for a root node', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(g.getAncestors('a')).toEqual(new Set());
  });

  it('returns immediate parent', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(g.getAncestors('b')).toEqual(new Set(['a']));
  });

  it('returns all transitive ancestors in a chain', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(g.getAncestors('c')).toEqual(new Set(['a', 'b']));
  });

  it('returns empty set for unknown node', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getAncestors('unknown')).toEqual(new Set());
  });

  it('returns all ancestors in diamond', () => {
    const g = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    expect(g.getAncestors('d')).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('DependencyGraph.getDescendants', () => {
  it('returns empty set for a leaf node', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(g.getDescendants('b')).toEqual(new Set());
  });

  it('returns immediate child', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(g.getDescendants('a')).toEqual(new Set(['b']));
  });

  it('returns all transitive descendants in a chain', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(g.getDescendants('a')).toEqual(new Set(['b', 'c']));
  });

  it('returns empty set for unknown node', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getDescendants('unknown')).toEqual(new Set());
  });
});

describe('DependencyGraph.topologicalSort', () => {
  it('returns single node for single-node graph', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.topologicalSort()).toEqual(['a']);
  });

  it('parent precedes child in linear chain', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    const order = g.topologicalSort();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('all parents precede child in diamond', () => {
    const g = new DependencyGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);
    const order = g.topologicalSort();
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('includes all nodes', () => {
    const nodes = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])];
    const g = new DependencyGraph(nodes);
    expect(g.topologicalSort()).toHaveLength(4);
  });
});

describe('DependencyGraph.getRootFailures', () => {
  it('returns empty array when no results', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getRootFailures([])).toEqual([]);
  });

  it('returns empty array when all pass', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    const results = [
      { criterionId: 'a', passed: true },
      { criterionId: 'b', passed: true },
    ];
    expect(g.getRootFailures(results)).toEqual([]);
  });

  it('returns failed root when no ancestors failed', () => {
    const g = new DependencyGraph([node('a')]);
    const results = [{ criterionId: 'a', passed: false }];
    expect(g.getRootFailures(results)).toEqual(results);
  });

  it('excludes child failure when parent also failed', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    const results = [
      { criterionId: 'a', passed: false },
      { criterionId: 'b', passed: false },
    ];
    const roots = g.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].criterionId).toBe('a');
  });

  it('returns multiple root failures from disconnected failing subtrees', () => {
    const g = new DependencyGraph([
      node('a'),
      node('b'),
      node('c', ['a']),
      node('d', ['b']),
    ]);
    const results = [
      { criterionId: 'a', passed: false },
      { criterionId: 'b', passed: false },
      { criterionId: 'c', passed: false },
      { criterionId: 'd', passed: false },
    ];
    const roots = g.getRootFailures(results);
    expect(roots.map(r => r.criterionId).sort()).toEqual(['a', 'b']);
  });

  it('works with featureId/detected format', () => {
    const g = new DependencyGraph([node('f1'), node('f2', ['f1'])]);
    const results = [
      { featureId: 'f1', detected: false },
      { featureId: 'f2', detected: false },
    ];
    const roots = g.getRootFailures(results);
    expect(roots).toHaveLength(1);
    expect(roots[0].featureId).toBe('f1');
  });
});

describe('DependencyGraph getNode / getAllNodes / deprecated aliases', () => {
  it('getNode returns undefined for unknown id', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getNode('x')).toBeUndefined();
  });

  it('getAllCriteria is an alias for getAllNodes', () => {
    const g = new DependencyGraph([node('a'), node('b', ['a'])]);
    expect(g.getAllCriteria()).toEqual(g.getAllNodes());
  });

  it('getCriterion is an alias for getNode', () => {
    const g = new DependencyGraph([node('a')]);
    expect(g.getCriterion('a')).toEqual(g.getNode('a'));
  });
});
