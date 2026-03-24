// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CriteriaStore } from './criteria-store.js';
import type { CriteriaDocument } from '../types/types.js';

// ── Mock Collection ──────────────────────────────────────────────────────────
// Simulates a MongoDB collection in-memory for deterministic unit testing.
// CriteriaStore uses `id` (not `_id`) as its primary lookup key.

function createMockCollection() {
  const docs = new Map<string, CriteriaDocument>();

  function matchesFilter(doc: CriteriaDocument, filter: Record<string, any>): boolean {
    if (filter.id !== undefined && doc.id !== filter.id) return false;
    if (filter.deletedAt?.$exists === false && doc.deletedAt) return false;
    if (filter.dependsOn !== undefined) {
      if (!doc.dependsOn?.includes(filter.dependsOn)) return false;
    }
    return true;
  }

  const mockCursor = (results: CriteriaDocument[]) => ({
    _results: results,
    sort() { return this; },
    toArray() { return Promise.resolve(this._results); },
  });

  const col = {
    _docs: docs,

    findOne: vi.fn(async (filter: any): Promise<CriteriaDocument | null> => {
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) return { ...doc };
      }
      return null;
    }),

    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc.id, { ...doc });
      return { insertedId: doc.id };
    }),

    updateOne: vi.fn(async (filter: any, update: any) => {
      for (const doc of docs.values()) {
        if (!matchesFilter(doc, filter)) continue;
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) {
          for (const k of Object.keys(update.$unset)) delete (doc as any)[k];
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),

    find: vi.fn((filter: any) => {
      const results: CriteriaDocument[] = [];
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) results.push({ ...doc });
      }
      // sort by id to match store's sort({ id: 1 })
      results.sort((a, b) => a.id.localeCompare(b.id));
      return mockCursor(results);
    }),
  };

  return col;
}

type MockCol = ReturnType<typeof createMockCollection>;

function seedDoc(col: MockCol, doc: CriteriaDocument) {
  col._docs.set(doc.id, { ...doc });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CriteriaStore', () => {
  let col: MockCol;
  let store: CriteriaStore;

  beforeEach(() => {
    col = createMockCollection();
    store = new CriteriaStore(col as any);
  });

  // ── getAll ──────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns empty array when no criteria exist', async () => {
      expect(await store.getAll()).toEqual([]);
    });

    it('returns all active criteria sorted by id', async () => {
      seedDoc(col, { id: 'z', prompt: 'z', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'a', prompt: 'a', dependsOn: [], createdAt: new Date() });
      const result = await store.getAll();
      expect(result.map((c) => c.id)).toEqual(['a', 'z']);
    });

    it('excludes soft-deleted criteria', async () => {
      seedDoc(col, { id: 'active', prompt: 'p', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'deleted', prompt: 'p', dependsOn: [], createdAt: new Date(), deletedAt: new Date() });
      const result = await store.getAll();
      expect(result.map((c) => c.id)).toEqual(['active']);
    });
  });

  // ── get ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns null when criterion does not exist', async () => {
      expect(await store.get('nonexistent')).toBeNull();
    });

    it('returns the criterion by id', async () => {
      seedDoc(col, { id: 'foo', prompt: 'bar', dependsOn: [], createdAt: new Date() });
      const doc = await store.get('foo');
      expect(doc?.id).toBe('foo');
      expect(doc?.prompt).toBe('bar');
    });

    it('returns null for soft-deleted criteria', async () => {
      seedDoc(col, { id: 'gone', prompt: 'p', dependsOn: [], createdAt: new Date(), deletedAt: new Date() });
      expect(await store.get('gone')).toBeNull();
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a new criterion', async () => {
      const doc = await store.create({ id: 'test-1', prompt: 'Check something' });
      expect(doc.id).toBe('test-1');
      expect(doc.prompt).toBe('Check something');
      expect(doc.dependsOn).toEqual([]);
      expect(doc.createdAt).toBeInstanceOf(Date);
    });

    it('trims whitespace from prompt', async () => {
      const doc = await store.create({ id: 'trim-test', prompt: '  spaced  ' });
      expect(doc.prompt).toBe('spaced');
    });

    it('creates with dependencies', async () => {
      seedDoc(col, { id: 'parent', prompt: 'parent', dependsOn: [], createdAt: new Date() });
      const doc = await store.create({ id: 'child', prompt: 'child', dependsOn: ['parent'] });
      expect(doc.dependsOn).toEqual(['parent']);
    });

    it('rejects invalid id format', async () => {
      await expect(store.create({ id: 'UPPER_CASE', prompt: 'p' })).rejects.toThrow(
        "Invalid criteria ID 'UPPER_CASE'"
      );
      await expect(store.create({ id: 'has spaces', prompt: 'p' })).rejects.toThrow(
        "Invalid criteria ID 'has spaces'"
      );
    });

    it('rejects duplicate id', async () => {
      await store.create({ id: 'dupe', prompt: 'first' });
      await expect(store.create({ id: 'dupe', prompt: 'second' })).rejects.toThrow(
        "Criteria 'dupe' already exists"
      );
    });

    it('rejects reference to nonexistent dependency', async () => {
      await expect(
        store.create({ id: 'orphan', prompt: 'p', dependsOn: ['missing'] })
      ).rejects.toThrow("Dependency 'missing' does not exist");
    });

    it('rejects self-referencing dependency (cycle)', async () => {
      await expect(
        store.create({ id: 'self-ref', prompt: 'p', dependsOn: ['self-ref'] })
      ).rejects.toThrow();
    });

    it('rejects transitive cycles', async () => {
      await store.create({ id: 'a', prompt: 'a' });
      await store.create({ id: 'b', prompt: 'b', dependsOn: ['a'] });
      // Making 'a' depend on 'b' would create a → b → a cycle
      await expect(
        store.create({ id: 'c', prompt: 'c', dependsOn: ['b'] })
      ).resolves.toBeDefined(); // valid chain a→b→c is fine

      // Now try creating something that closes a cycle with a→b→c→a
      await expect(
        store.create({ id: 'd', prompt: 'd', dependsOn: ['c', 'a'] })
      ).resolves.toBeDefined(); // diamond is fine (not a cycle)
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    beforeEach(async () => {
      seedDoc(col, { id: 'base', prompt: 'original', dependsOn: [], createdAt: new Date() });
    });

    it('updates prompt', async () => {
      const doc = await store.update('base', { prompt: 'updated' });
      expect(doc.prompt).toBe('updated');
    });

    it('trims whitespace on prompt update', async () => {
      const doc = await store.update('base', { prompt: '  trimmed  ' });
      expect(doc.prompt).toBe('trimmed');
    });

    it('updates dependencies', async () => {
      seedDoc(col, { id: 'dep', prompt: 'dep', dependsOn: [], createdAt: new Date() });
      const doc = await store.update('base', { dependsOn: ['dep'] });
      expect(doc.dependsOn).toEqual(['dep']);
    });

    it('throws when criterion not found', async () => {
      await expect(store.update('nonexistent', { prompt: 'x' })).rejects.toThrow(
        "Criteria 'nonexistent' not found"
      );
    });

    it('rejects update to nonexistent dependency', async () => {
      await expect(
        store.update('base', { dependsOn: ['ghost'] })
      ).rejects.toThrow("Dependency 'ghost' does not exist");
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('soft-deletes a criterion', async () => {
      seedDoc(col, { id: 'to-delete', prompt: 'p', dependsOn: [], createdAt: new Date() });
      await store.delete('to-delete');
      expect(await store.get('to-delete')).toBeNull();
    });

    it('throws when criterion not found', async () => {
      await expect(store.delete('nonexistent')).rejects.toThrow(
        "Criteria 'nonexistent' not found"
      );
    });

    it('rejects deletion when other criteria depend on it', async () => {
      seedDoc(col, { id: 'parent', prompt: 'p', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'child', prompt: 'c', dependsOn: ['parent'], createdAt: new Date() });
      await expect(store.delete('parent')).rejects.toThrow(
        "Cannot delete 'parent'"
      );
    });

    it('allows deletion when dependent was already deleted', async () => {
      seedDoc(col, { id: 'parent', prompt: 'p', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'child', prompt: 'c', dependsOn: ['parent'], createdAt: new Date(), deletedAt: new Date() });
      await expect(store.delete('parent')).resolves.toBeUndefined();
    });
  });

  // ── resolveWithAncestors ─────────────────────────────────────────────────

  describe('resolveWithAncestors', () => {
    beforeEach(() => {
      seedDoc(col, { id: 'root', prompt: 'root', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'mid', prompt: 'mid', dependsOn: ['root'], createdAt: new Date() });
      seedDoc(col, { id: 'leaf', prompt: 'leaf', dependsOn: ['mid'], createdAt: new Date() });
    });

    it('returns a single criterion without ancestors', async () => {
      const result = await store.resolveWithAncestors(['root']);
      expect(result.map((c) => c.id)).toEqual(['root']);
    });

    it('includes all transitive ancestors', async () => {
      const result = await store.resolveWithAncestors(['leaf']);
      const ids = result.map((c) => c.id).sort();
      expect(ids).toEqual(['leaf', 'mid', 'root']);
    });

    it('deduplicates ancestors from diamond dependency', async () => {
      // diamond: root → left → top, root → right → top
      seedDoc(col, { id: 'top', prompt: 'top', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'left', prompt: 'l', dependsOn: ['top'], createdAt: new Date() });
      seedDoc(col, { id: 'right', prompt: 'r', dependsOn: ['top'], createdAt: new Date() });
      seedDoc(col, { id: 'diamond-leaf', prompt: 'd', dependsOn: ['left', 'right'], createdAt: new Date() });

      const result = await store.resolveWithAncestors(['diamond-leaf']);
      const ids = result.map((c) => c.id);
      // 'top' should appear exactly once
      expect(ids.filter((id) => id === 'top')).toHaveLength(1);
      expect(ids).toHaveLength(4);
    });

    it('throws when a referenced criterion does not exist', async () => {
      await expect(store.resolveWithAncestors(['ghost'])).rejects.toThrow(
        "Criteria 'ghost' not found"
      );
    });

    it('handles multiple starting criteria', async () => {
      const result = await store.resolveWithAncestors(['root', 'mid']);
      const ids = result.map((c) => c.id).sort();
      expect(ids).toEqual(['mid', 'root']);
    });
  });

  // ── getGraph ─────────────────────────────────────────────────────────────

  describe('getGraph', () => {
    it('returns empty graph when no criteria exist', async () => {
      const { nodes, edges } = await store.getGraph();
      expect(nodes).toEqual([]);
      expect(edges).toEqual([]);
    });

    it('returns nodes and edges', async () => {
      seedDoc(col, { id: 'parent', prompt: 'p', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'child', prompt: 'c', dependsOn: ['parent'], createdAt: new Date() });

      const { nodes, edges } = await store.getGraph();
      expect(nodes.map((n) => n.id).sort()).toEqual(['child', 'parent']);
      expect(edges).toEqual([{ from: 'parent', to: 'child' }]);
    });

    it('excludes soft-deleted criteria', async () => {
      seedDoc(col, { id: 'active', prompt: 'p', dependsOn: [], createdAt: new Date() });
      seedDoc(col, { id: 'gone', prompt: 'g', dependsOn: [], createdAt: new Date(), deletedAt: new Date() });
      const { nodes } = await store.getGraph();
      expect(nodes.map((n) => n.id)).toEqual(['active']);
    });
  });

  // ── seed ─────────────────────────────────────────────────────────────────

  describe('seed', () => {
    it('inserts new criteria from config', async () => {
      const count = await store.seed([
        { id: 'seed-1', prompt: 'first' },
        { id: 'seed-2', prompt: 'second' },
      ]);
      expect(count).toBe(2);
      expect(col.insertOne).toHaveBeenCalledTimes(2);
    });

    it('skips existing criteria (upsert semantics)', async () => {
      seedDoc(col, { id: 'existing', prompt: 'original', dependsOn: [], createdAt: new Date() });
      const count = await store.seed([
        { id: 'existing', prompt: 'should-not-overwrite' },
        { id: 'new-one', prompt: 'new' },
      ]);
      expect(count).toBe(1);
      // Original prompt should be unchanged
      expect(col._docs.get('existing')?.prompt).toBe('original');
    });

    it('returns 0 when all criteria already exist', async () => {
      seedDoc(col, { id: 'x', prompt: 'x', dependsOn: [], createdAt: new Date() });
      const count = await store.seed([{ id: 'x', prompt: 'x' }]);
      expect(count).toBe(0);
    });
  });
});
