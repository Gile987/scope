// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { CodebaseStore } from "./codebase-store.js";
import type { CodebaseDocument } from "../types/codebase.js";

type UnknownRecord = Record<string, unknown>;

function matches(doc: CodebaseDocument, filter: UnknownRecord): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key as keyof CodebaseDocument];
    if (typeof condition === "object" && condition !== null && "$exists" in condition) {
      const exists = value !== undefined;
      if ((condition as { $exists: boolean }).$exists !== exists) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function makeCodebaseCollection(seed: CodebaseDocument[] = []) {
  const docs = seed.map((doc) => ({ ...doc }));
  return {
    docs,
    async findOne(filter: UnknownRecord) {
      return docs.find((doc) => matches(doc, filter)) ?? null;
    },
    find(filter: UnknownRecord) {
      let result = docs.filter((doc) => matches(doc, filter));
      return {
        sort(sortSpec: UnknownRecord) {
          if (sortSpec.createdAt === -1) {
            result = [...result].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: CodebaseDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter: UnknownRecord, update: { $set?: Partial<CodebaseDocument> }) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter: UnknownRecord) {
      const index = docs.findIndex((candidate) => matches(candidate, filter));
      if (index === -1) return { deletedCount: 0 };
      docs.splice(index, 1);
      return { deletedCount: 1 };
    },
    async findOneAndUpdate(
      filter: UnknownRecord,
      update: { $set?: Partial<CodebaseDocument>; $inc?: { revisionCounter?: number } }
    ) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      if (update.$inc?.revisionCounter !== undefined) {
        doc.revisionCounter += update.$inc.revisionCounter;
      }
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },
  };
}

type CodebaseStorePrivate = {
  ensureUniqueSlug(base: string): Promise<string>;
};

describe("CodebaseStore", () => {
  it("creates a codebase with generated metadata and persisted fields", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);

    const created = await store.create({
      name: "Pamela Fox Site",
      sourceType: "git",
      source: "pamelafox/site",
      defaultBranch: "main",
      creator: "tester",
    });

    expect(created._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({
      slug: "pamela-fox-site",
      name: "Pamela Fox Site",
      sourceType: "git",
      source: "pamelafox/site",
      defaultBranch: "main",
      revisionCounter: 0,
      creator: "tester",
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await store.get(created._id)).toEqual(created);
  });

  it("gets by slug, soft-deletes codebases, and excludes deleted entries from list", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const first = await store.create({ name: "First", sourceType: "archive" });
    const second = await store.create({ name: "Second", sourceType: "archive" });

    expect(await store.getBySlug(first.slug)).toEqual(first);
    expect(await store.softDelete(first._id)).toBe(true);
    expect(await store.getBySlug(first.slug)).toBeNull();
    expect(await store.list()).toEqual([second]);
    expect((await store.get(first._id, { includeDeleted: true }))?.deletedAt).toBeInstanceOf(Date);
  });

  it("hard-deletes a codebase, removing it entirely and freeing its slug", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const created = await store.create({ name: "Orphan", slug: "orphan", sourceType: "archive" });

    expect(await store.hardDelete(created._id)).toBe(true);
    // Fully removed (not just soft-deleted): not retrievable even with includeDeleted.
    expect(await store.get(created._id, { includeDeleted: true })).toBeNull();
    // Slug is freed, so a new codebase can reuse it without suffixing.
    const reused = await store.create({ name: "Reused", slug: "orphan", sourceType: "archive" });
    expect(reused.slug).toBe("orphan");
    // Deleting a missing codebase reports no deletion.
    expect(await store.hardDelete("missing-codebase")).toBe(false);
  });

  it("allocates revision numbers sequentially and returns null for missing codebases", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const created = await store.create({ name: "Sequential", sourceType: "archive" });

    await expect(store.allocateRevisionNumber(created._id)).resolves.toBe(1);
    await expect(store.allocateRevisionNumber(created._id)).resolves.toBe(2);
    await expect(store.allocateRevisionNumber("missing-codebase")).resolves.toBeNull();
  });

  it("ensures unique slugs by suffixing taken bases", async () => {
    const collection = makeCodebaseCollection();
    const store = new CodebaseStore(collection as unknown as Collection<CodebaseDocument>);
    const privateStore = store as unknown as CodebaseStorePrivate;

    await expect(privateStore.ensureUniqueSlug("free-slug")).resolves.toBe("free-slug");
    await store.create({ name: "Taken", slug: "taken", sourceType: "archive" });
    await store.create({ name: "Taken 2", slug: "taken-2", sourceType: "archive" });

    await expect(privateStore.ensureUniqueSlug("taken")).resolves.toBe("taken-3");
  });
});
