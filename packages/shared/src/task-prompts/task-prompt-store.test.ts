// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskPromptStore } from "./task-prompt-store.js";
import { computeTaskPromptId, computePromptId } from "./task-prompt-id.js";
import type { TaskPromptDocument, PromptFeatureResult } from "../types/types.js";

// ── Mock Collection ──────────────────────────────────────────────────────────
// Simulates a MongoDB collection in-memory for deterministic unit testing.

function createMockCollection() {
  const docs = new Map<string, TaskPromptDocument>();

  const mockCursor = (results: TaskPromptDocument[]) => ({
    _results: results,
    sort() { return this; },
    skip(n: number) { this._results = this._results.slice(n); return this; },
    limit(n: number) { this._results = this._results.slice(0, n); return this; },
    toArray() { return Promise.resolve(this._results); },
  });

  return {
    _docs: docs,

    findOne: vi.fn(async (filter: any) => {
      if (filter._id) {
        const doc = docs.get(filter._id);
        if (!doc) return null;
        // Check deletedAt filter
        if (filter.deletedAt && filter.deletedAt.$exists === false && doc.deletedAt) {
          return null;
        }
        return { ...doc };
      }
      return null;
    }),

    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),

    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = docs.get(filter._id);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      // Check deletedAt filter if present
      if (filter.deletedAt && filter.deletedAt.$exists === false && doc.deletedAt) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete (doc as any)[key];
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }),

    countDocuments: vi.fn(async (filter: any) => {
      let count = 0;
      for (const doc of docs.values()) {
        if (filter.deletedAt?.$exists === false && doc.deletedAt) continue;
        if (!matchesType(filter, doc)) continue;
        if (filter.text?.$regex) {
          const regex = new RegExp(filter.text.$regex, filter.text.$options);
          if (!regex.test(doc.text ?? "")) continue;
        }
        count++;
      }
      return count;
    }),

    find: vi.fn((filter: any) => {
      const results: TaskPromptDocument[] = [];
      for (const doc of docs.values()) {
        if (filter.deletedAt?.$exists === false && doc.deletedAt) continue;
        if (!matchesType(filter, doc)) continue;
        if (filter.text?.$regex) {
          const regex = new RegExp(filter.text.$regex, filter.text.$options);
          if (!regex.test(doc.text ?? "")) continue;
        }
        results.push({ ...doc });
      }
      return mockCursor(results);
    }),
  };
}

/** Replicates the store's `$or`/`type` filter against an in-memory doc. */
function matchesType(filter: any, doc: TaskPromptDocument): boolean {
  if (filter.$or) {
    return filter.$or.some((clause: any) => {
      if (clause.type?.$exists === false) return doc.type === undefined;
      return doc.type === clause.type;
    });
  }
  if (filter.type !== undefined) {
    const cond = filter.type;
    if (cond && typeof cond === "object") {
      // `$nin` (and `$in`) treat a missing `type` as `undefined` — mirrors Mongo,
      // so legacy untyped docs stay visible under the default `$nin` filter.
      if (Array.isArray(cond.$nin)) return !cond.$nin.includes(doc.type);
      if (Array.isArray(cond.$in)) return cond.$in.includes(doc.type);
    }
    return doc.type === cond;
  }
  return true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TaskPromptStore", () => {
  let col: ReturnType<typeof createMockCollection>;
  let store: TaskPromptStore;

  beforeEach(() => {
    col = createMockCollection();
    store = new TaskPromptStore(col as any);
  });

  // -- findOrCreate ---------------------------------------------------------

  describe("findOrCreate", () => {
    it("creates a new task prompt", async () => {
      const doc = await store.findOrCreate("Hello world");
      const expectedId = computeTaskPromptId("Hello world");
      expect(doc._id).toBe(expectedId);
      expect(doc.text).toBe("Hello world");
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.deletedAt).toBeUndefined();
    });

    it("is idempotent — returns existing doc on second call", async () => {
      const a = await store.findOrCreate("Hello world");
      const b = await store.findOrCreate("Hello world");
      expect(a._id).toBe(b._id);
      expect(col.insertOne).toHaveBeenCalledTimes(1);
    });

    it("trims whitespace", async () => {
      const a = await store.findOrCreate("  foo  ");
      expect(a.text).toBe("foo");
      expect(a._id).toBe(computeTaskPromptId("foo"));
    });

    it("revives a soft-deleted document", async () => {
      const doc = await store.findOrCreate("deleted prompt");
      await store.delete(doc._id);

      const revived = await store.findOrCreate("deleted prompt");
      expect(revived._id).toBe(doc._id);
      expect(revived.deletedAt).toBeUndefined();
    });

    it("namespaces non-task types into a distinct id", async () => {
      const task = await store.findOrCreate("same text");
      const agents = await store.findOrCreate("same text", "agents.md");
      expect(agents._id).not.toBe(task._id);
      expect(agents._id).toBe(computePromptId("agents.md", "same text"));
      expect(agents.type).toBe("agents.md");
    });

    it("keeps task ids backward-compatible (unchanged by type arg)", async () => {
      const a = await store.findOrCreate("hello");
      const b = await store.findOrCreate("hello", "select");
      expect(a._id).toBe(b._id);
      expect(a._id).toBe(computeTaskPromptId("hello"));
    });
  });

  // -- size-based storage ---------------------------------------------------

  describe("size-based storage", () => {
    function createMockBlob() {
      const blobs = new Map<string, string>();
      return {
        store: blobs,
        uploadText: vi.fn(async (name: string, text: string) => {
          blobs.set(name, text);
          return `https://acct.blob/snapshots/${name}`;
        }),
        downloadBlobToBuffer: vi.fn(async (name: string) => {
          const v = blobs.get(name);
          if (v === undefined) throw new Error(`blob ${name} not found`);
          return Buffer.from(v, "utf-8");
        }),
      };
    }

    it("stores small bodies inline and never touches blob", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 1024);
      const doc = await s.findOrCreate("tiny");
      expect(doc.text).toBe("tiny");
      expect(doc.contentBlobUrl).toBeUndefined();
      expect(blob.uploadText).not.toHaveBeenCalled();
    });

    it("uploads over-threshold bodies to blob on a create miss", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "x".repeat(64);
      const doc = await s.findOrCreate(big, "agents.md");
      expect(doc.text).toBeUndefined();
      expect(doc.contentBlobUrl).toContain(`prompts/${doc._id}.txt`);
      expect(blob.uploadText).toHaveBeenCalledTimes(1);
    });

    it("skips the upload on a hit (idempotent)", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "y".repeat(64);
      await s.findOrCreate(big, "agents.md");
      await s.findOrCreate(big, "agents.md");
      expect(blob.uploadText).toHaveBeenCalledTimes(1);
    });

    it("resolvePromptText returns inline text without blob access", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 1024);
      const doc = await s.findOrCreate("inline body");
      expect(await s.resolvePromptText(doc)).toBe("inline body");
      expect(blob.downloadBlobToBuffer).not.toHaveBeenCalled();
    });

    it("resolvePromptText downloads blob-backed bodies", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const big = "z".repeat(64);
      const doc = await s.findOrCreate(big, "agents.md");
      expect(await s.resolvePromptText(doc)).toBe(big);
      expect(blob.downloadBlobToBuffer).toHaveBeenCalledTimes(1);
    });

    it("rejects bodies over the hard max size", async () => {
      const blob = createMockBlob();
      const s = new TaskPromptStore(col as any, blob as any, 16);
      const huge = "a".repeat(256 * 1024 + 1);
      await expect(s.findOrCreate(huge)).rejects.toThrow(/maximum/);
    });

    it("throws when an over-threshold body has no blob storage configured", async () => {
      const s = new TaskPromptStore(col as any, undefined, 16);
      await expect(s.findOrCreate("b".repeat(64))).rejects.toThrow(/BlobStorage/);
    });
  });

  // -- get ------------------------------------------------------------------

  describe("get", () => {
    it("returns null for non-existent ID", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns the document by ID", async () => {
      const created = await store.findOrCreate("test prompt");
      const result = await store.get(created._id);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("test prompt");
    });

    it("returns null for soft-deleted documents", async () => {
      const created = await store.findOrCreate("to be deleted");
      await store.delete(created._id);
      const result = await store.get(created._id);
      expect(result).toBeNull();
    });
  });

  // -- getByText ------------------------------------------------------------

  describe("getByText", () => {
    it("finds a document by text content", async () => {
      await store.findOrCreate("find me");
      const result = await store.getByText("find me");
      expect(result).not.toBeNull();
      expect(result!.text).toBe("find me");
    });

    it("returns null for unknown text", async () => {
      const result = await store.getByText("unknown text");
      expect(result).toBeNull();
    });
  });

  // -- delete ---------------------------------------------------------------

  describe("delete", () => {
    it("soft-deletes a document", async () => {
      const doc = await store.findOrCreate("deletion target");
      await store.delete(doc._id);
      const result = await store.get(doc._id);
      expect(result).toBeNull();
    });

    it("throws when deleting non-existent ID", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow(
        "Task prompt 'nonexistent' not found",
      );
    });
  });

  // -- getAll ---------------------------------------------------------------

  describe("getAll", () => {
    it("returns empty list when no documents exist", async () => {
      const { items, total } = await store.getAll();
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it("returns all active documents", async () => {
      await store.findOrCreate("first");
      await store.findOrCreate("second");
      const { items, total } = await store.getAll();
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
    });

    it("excludes soft-deleted documents", async () => {
      const doc = await store.findOrCreate("will delete");
      await store.findOrCreate("will keep");
      await store.delete(doc._id);
      const { items, total } = await store.getAll();
      expect(total).toBe(1);
      expect(items[0].text).toBe("will keep");
    });

    it("supports search filter", async () => {
      await store.findOrCreate("Azure deployment");
      await store.findOrCreate("React frontend");
      const { items, total } = await store.getAll({ search: "azure" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("Azure deployment");
    });

    it("defaults to task-typed prompts (and legacy untyped docs)", async () => {
      await store.findOrCreate("a task prompt");
      await store.findOrCreate("an agents file", "agents.md");
      const { items, total } = await store.getAll();
      expect(total).toBe(1);
      expect(items[0].text).toBe("a task prompt");
    });

    it("filters by agents.md type", async () => {
      await store.findOrCreate("a task prompt");
      await store.findOrCreate("an agents file", "agents.md");
      const { items, total } = await store.getAll({ type: "agents.md" });
      expect(total).toBe(1);
      expect(items[0].text).toBe("an agents file");
    });
  });

  // -- attachFeatures -------------------------------------------------------

  describe("attachFeatures", () => {
    it("attaches features to a task prompt", async () => {
      const doc = await store.findOrCreate("feature target");
      const features: PromptFeatureResult[] = [
        { featureId: "has_node", detected: true, evaluated: true },
        { featureId: "has_react", detected: false, evaluated: true },
      ];

      const updated = await store.attachFeatures(doc._id, features);
      expect(updated.features).toEqual(features);
      expect(updated.featuresExtractedAt).toBeInstanceOf(Date);
    });

    it("throws when attaching to non-existent ID", async () => {
      await expect(
        store.attachFeatures("nonexistent", []),
      ).rejects.toThrow("Task prompt 'nonexistent' not found");
    });

    it("overwrites previous features", async () => {
      const doc = await store.findOrCreate("overwrite target");
      const v1: PromptFeatureResult[] = [{ featureId: "a", detected: true, evaluated: true }];
      const v2: PromptFeatureResult[] = [{ featureId: "b", detected: false, evaluated: true }];

      await store.attachFeatures(doc._id, v1);
      const updated = await store.attachFeatures(doc._id, v2);
      expect(updated.features).toEqual(v2);
    });
  });
});
