// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { DependencyGraph } from './dependency-graph.js';

// Minimal helper to build nodes quickly
function node(id: string, dependsOn?: string[]) {
  return { id, dependsOn };
}

describe('DependencyGraph', () => {
  describe('construction', () => {
    it('accepts an empty node list', () => {
      const g = new DependencyGraph([]);
      expect(g.getAllNodes()).toEqual([]);
    });

    it('accepts a single node with no dependencies', () => {
      const g = new DependencyGraph([node('a')]);
      expect(g.getNode('a')).toMatchObject({ id: 'a' });
    });

    it('accepts a chain A → B → C', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
      expect(g.getAllNodes()).toHaveLength(3);
    });

    it('throws on duplicate node ids', () => {
      expect(() => new DependencyGraph([node('a'), node('a')])).toThrow(/Duplicate/);
    });

    it('throws when a dependency references an unknown node', () => {
      expect(() => new DependencyGraph([node('b', ['a'])])).toThrow(/unknown node/);
    });

    it('throws on a direct cycle (A → B → A)', () => {
      // Build the graph step by step to have both nodes registered first,
      // then wire the edge that creates the cycle manually — but since the
      // constructor validates all edges, we create the cycle declaratively:
      expect(() =>
        new DependencyGraph([node('a', ['b']), node('b', ['a'])])
      ).toThrow(/[Cc]ycle/);
    });

    it('throws on an indirect cycle (A → B → C → A)', () => {
      expect(() =>
        new DependencyGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])])
      ).toThrow(/[Cc]ycle/);
    });

    it('throws on a self-loop', () => {
      expect(() => new DependencyGraph([node('a', ['a'])])).toThrow();
    });
  });

  describe('getNode / getAllNodes', () => {
    it('returns undefined for unknown ids', () => {
      const g = new DependencyGraph([node('x')]);
      expect(g.getNode('missing')).toBeUndefined();
    });

    it('getAllNodes returns all nodes', () => {
      const nodes = [node('a'), node('b'), node('c')];
      const g = new DependencyGraph(nodes);
      const ids = g.getAllNodes().map(n => n.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    });
  });

  describe('deprecated aliases', () => {
    it('getAllCriteria delegates to getAllNodes', () => {
      const g = new DependencyGraph([node('a'), node('b')]);
      expect(g.getAllCriteria()).toEqual(g.getAllNodes());
    });

    it('getCriterion delegates to getNode', () => {
      const g = new DependencyGraph([node('a')]);
      expect(g.getCriterion('a')).toEqual(g.getNode('a'));
      expect(g.getCriterion('missing')).toBeUndefined();
    });
  });

  describe('topologicalSort', () => {
    it('returns single node for singleton graph', () => {
      expect(new DependencyGraph([node('a')]).topologicalSort()).toEqual(['a']);
    });

    it('parents appear before children in a chain', () => {
      // A is parent of B, B is parent of C
      const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
      const order = g.topologicalSort();
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    });

    it('diamond dependency: both parents appear before child', () => {
      // A and B are both parents of C
      const g = new DependencyGraph([node('a'), node('b'), node('c', ['a', 'b'])]);
      const order = g.topologicalSort();
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    });

    it('returns all node ids', () => {
      const g = new DependencyGraph([node('x'), node('y', ['x']), node('z')]);
      expect(g.topologicalSort().sort()).toEqual(['x', 'y', 'z']);
    });
  });

  describe('getAncestors', () => {
    it('returns empty set for root nodes', () => {
      const g = new DependencyGraph([node('root')]);
      expect(g.getAncestors('root').size).toBe(0);
    });

    it('returns empty set for unknown ids', () => {
      const g = new DependencyGraph([node('a')]);
      expect(g.getAncestors('unknown').size).toBe(0);
    });

    it('returns direct parent', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a'])]);
      expect(g.getAncestors('b')).toEqual(new Set(['a']));
    });

    it('returns transitive ancestors in a chain', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
      expect(g.getAncestors('c')).toEqual(new Set(['a', 'b']));
    });

    it('deduplicates in a diamond graph (A → {B, C} → D)', () => {
      // D depends on both B and C; B and C both depend on A
      const g = new DependencyGraph([
        node('a'),
        node('b', ['a']),
        node('c', ['a']),
        node('d', ['b', 'c']),
      ]);
      const ancestors = g.getAncestors('d');
      expect(ancestors).toEqual(new Set(['a', 'b', 'c']));
    });
  });

  describe('getDescendants', () => {
    it('returns empty set for leaf nodes', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a'])]);
      expect(g.getDescendants('b').size).toBe(0);
    });

    it('returns empty set for unknown ids', () => {
      const g = new DependencyGraph([node('a')]);
      expect(g.getDescendants('ghost').size).toBe(0);
    });

    it('returns direct child', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a'])]);
      expect(g.getDescendants('a')).toEqual(new Set(['b']));
    });

    it('returns transitive descendants in a chain', () => {
      const g = new DependencyGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
      expect(g.getDescendants('a')).toEqual(new Set(['b', 'c']));
    });

    it('deduplicates in a diamond graph', () => {
      const g = new DependencyGraph([
        node('a'),
        node('b', ['a']),
        node('c', ['a']),
        node('d', ['b', 'c']),
      ]);
      expect(g.getDescendants('a')).toEqual(new Set(['b', 'c', 'd']));
    });
  });

  describe('getRootFailures', () => {
    describe('with criterionId/passed format', () => {
      const g = new DependencyGraph([
        node('a'),
        node('b', ['a']),
        node('c', ['b']),
        node('d'),
      ]);

      it('returns empty when all pass', () => {
        const results = [
          { criterionId: 'a', passed: true, feedback: '', evaluated: true },
          { criterionId: 'b', passed: true, feedback: '', evaluated: true },
        ];
        expect(g.getRootFailures(results)).toEqual([]);
      });

      it('returns leaf failure when no ancestors failed', () => {
        const results = [
          { criterionId: 'a', passed: true, feedback: '', evaluated: true },
          { criterionId: 'b', passed: false, feedback: 'no', evaluated: true },
        ];
        expect(g.getRootFailures(results)).toHaveLength(1);
        expect(g.getRootFailures(results)[0].criterionId).toBe('b');
      });

      it('returns root failure and suppresses descendant failures', () => {
        // A fails → B and C also fail, but only A is the root cause
        const results = [
          { criterionId: 'a', passed: false, feedback: 'fail', evaluated: true },
          { criterionId: 'b', passed: false, feedback: 'skip', evaluated: false },
          { criterionId: 'c', passed: false, feedback: 'skip', evaluated: false },
        ];
        const roots = g.getRootFailures(results);
        expect(roots).toHaveLength(1);
        expect(roots[0].criterionId).toBe('a');
      });

      it('returns multiple independent root failures', () => {
        // a and d are both roots (no shared ancestry)
        const results = [
          { criterionId: 'a', passed: false, feedback: 'f', evaluated: true },
          { criterionId: 'd', passed: false, feedback: 'f', evaluated: true },
        ];
        const rootIds = g.getRootFailures(results).map(r => r.criterionId).sort();
        expect(rootIds).toEqual(['a', 'd']);
      });
    });

    describe('with featureId/detected format', () => {
      const g = new DependencyGraph([node('f1'), node('f2', ['f1'])]);

      it('returns root failure for featureId/detected=false', () => {
        const results = [
          { featureId: 'f1', detected: false },
          { featureId: 'f2', detected: false },
        ];
        const roots = g.getRootFailures(results);
        expect(roots).toHaveLength(1);
        expect(roots[0].featureId).toBe('f1');
      });

      it('returns empty when all features detected', () => {
        const results = [
          { featureId: 'f1', detected: true },
          { featureId: 'f2', detected: true },
        ];
        expect(g.getRootFailures(results)).toEqual([]);
      });
    });
  });
});
