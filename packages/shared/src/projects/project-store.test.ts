// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { ProjectStore } from "./project-store.js";
import type { ProjectDocument } from "../types/project.js";

type UnknownRecord = Record<string, unknown>;

function matches(doc: ProjectDocument, filter: UnknownRecord): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const value = doc[key as keyof ProjectDocument];
    if (typeof condition === "object" && condition !== null && "$exists" in condition) {
      const exists = value !== undefined;
      if ((condition as { $exists: boolean }).$exists !== exists) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function makeProjectCollection(seed: ProjectDocument[] = []) {
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
        async toArray() {
          return result;
        },
      };
    },
    async insertOne(doc: ProjectDocument) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter: UnknownRecord, update: { $set?: Partial<ProjectDocument> }) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter: UnknownRecord, update: { $set?: Partial<ProjectDocument> }) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },
  };
}

describe("ProjectStore", () => {
  it("creates a project with a fresh UUID and persisted fields", async () => {
    const collection = makeProjectCollection();
    const store = new ProjectStore(collection as unknown as Collection<ProjectDocument>);

    const created = await store.create({
      name: "My Project",
      description: "A workspace",
      creator: "tester",
    });

    expect(created._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({
      name: "My Project",
      description: "A workspace",
      creator: "tester",
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await store.get(created._id)).toEqual(created);
  });

  it("trims the name and rejects an empty one", async () => {
    const collection = makeProjectCollection();
    const store = new ProjectStore(collection as unknown as Collection<ProjectDocument>);

    const created = await store.create({ name: "  Spaced  " });
    expect(created.name).toBe("Spaced");

    await expect(store.create({ name: "   " })).rejects.toThrow(/name is required/i);
  });

  it("lists newest first and excludes soft-deleted projects", async () => {
    const collection = makeProjectCollection();
    const store = new ProjectStore(collection as unknown as Collection<ProjectDocument>);
    const first = await store.create({ name: "First" });
    // Ensure distinct createdAt ordering.
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.create({ name: "Second" });

    const listed = await store.list();
    expect(listed.map((p) => p._id)).toEqual([second._id, first._id]);

    expect(await store.softDelete(first._id)).toBe(true);
    expect(await store.get(first._id)).toBeNull();
    expect((await store.get(first._id, { includeDeleted: true }))?.deletedAt).toBeInstanceOf(Date);
    expect((await store.list()).map((p) => p._id)).toEqual([second._id]);
  });

  it("updates mutable metadata and sets updatedAt", async () => {
    const collection = makeProjectCollection();
    const store = new ProjectStore(collection as unknown as Collection<ProjectDocument>);
    const created = await store.create({ name: "Before" });

    const updated = await store.update(created._id, { name: "After", description: "desc" });
    expect(updated?.name).toBe("After");
    expect(updated?.description).toBe("desc");
    expect(updated?.updatedAt).toBeInstanceOf(Date);

    expect(await store.update("missing", { name: "x" })).toBeNull();
  });
});
