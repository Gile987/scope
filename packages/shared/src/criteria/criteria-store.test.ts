// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { CriteriaStore } from "./criteria-store.js";
import {
  CriteriaDuplicateError,
  CriteriaHasDependentsError,
  CriteriaNotFoundError,
  CriteriaValidationError,
} from "./criteria-errors.js";
import type { CriteriaDocument, GateId } from "../types/types.js";

/**
 * Minimal in-memory fake of the subset of the MongoDB Collection API that
 * CriteriaStore exercises: findOne, insertOne, updateOne and find().sort().toArray().
 */
function fakeCollection(seed: CriteriaDocument[] = []) {
  let docs: CriteriaDocument[] = seed.map((d) => ({ ...d }));

  const matches = (doc: any, filter: any): boolean => {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === "deletedAt") {
        const hasDeleted = doc.deletedAt !== undefined;
        if ((cond as any)?.$exists === false && hasDeleted) return false;
        if ((cond as any)?.$exists === true && !hasDeleted) return false;
        continue;
      }
      if (key === "dependsOn") {
        if (!Array.isArray(doc.dependsOn) || !doc.dependsOn.includes(cond)) return false;
        continue;
      }
      if (doc[key] !== cond) return false;
    }
    return true;
  };

  return {
    _docs: () => docs,
    async findOne(filter: any) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    async insertOne(doc: any) {
      // Faithfully model the full unique index on `id` (migration 002): it does
      // NOT exclude soft-deleted docs, so inserting over a tombstone collides.
      if (docs.some((d) => d.id === doc.id)) {
        throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { insertedId: doc.id };
    },
    async updateOne(filter: any, update: any) {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) {
          for (const key of Object.keys(update.$unset)) delete (doc as any)[key];
        }
      }
      return { matchedCount: doc ? 1 : 0 };
    },
    find(filter: any) {
      let result = docs.filter((d) => matches(d, filter));
      return {
        sort() {
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
  } as any;
}

describe("CriteriaStore gate-compatibility invariant", () => {
  it("allows a child whose gates are a subset of its parent's gates", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["build"] }),
    ).resolves.toMatchObject({ id: "child", gates: ["build"] });
  });

  it("rejects a child compatible with a gate its parent is not", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"] }),
    ).rejects.toThrow(/not/i);
  });

  it("rejects an unrestricted child of a restricted parent", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // No gates on child => universal (all gates) => must fail against select-only parent.
    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).rejects.toThrow();
  });

  it("allows an unrestricted child of an unrestricted parent", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).resolves.toMatchObject({ id: "child" });
  });

  it("enforces the invariant on update too", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.update("child", { gates: ["select", "build"] as GateId[] }),
    ).rejects.toThrow();
  });

  it("rejects narrowing a parent below an existing dependent's gates (parent side)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // Narrowing parent to just [select] would leave child (compatible with build)
    // depending on a parent that is not — the parent-side invariant must reject.
    await expect(
      store.update("parent", { gates: ["select"] as GateId[] }),
    ).rejects.toThrow(CriteriaValidationError);
  });
});

describe("CriteriaStore cycle detection", () => {
  it("rejects a direct cycle on create", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ projectId: "proj-test", id: "b", prompt: "b", dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a transitive cycle on update", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
      { projectId: "proj-test", id: "b", prompt: "b", dependsOn: ["a"], createdAt: new Date() },
      { projectId: "proj-test", id: "c", prompt: "c", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // a -> b -> c already; making a depend on c closes the loop a->c->b->a.
    await expect(
      store.update("a", { dependsOn: ["c"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a self-reference", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.update("a", { dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });
});

describe("CriteriaStore typed errors", () => {
  it("throws CriteriaValidationError for an invalid id format", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.create({ projectId: "proj-test", id: "Bad-Id", prompt: "p" })).rejects.toThrow(
      CriteriaValidationError,
    );
  });

  it("throws CriteriaDuplicateError when the id already exists", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "dup", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await expect(store.create({ projectId: "proj-test", id: "dup", prompt: "p" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });

  it("throws CriteriaValidationError when a dependency does not exist", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(
      store.create({ projectId: "proj-test", id: "a", prompt: "p", dependsOn: ["missing"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("throws CriteriaNotFoundError on update of a missing criterion", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.update("ghost", { prompt: "x" })).rejects.toThrow(
      CriteriaNotFoundError,
    );
  });

  it("throws CriteriaNotFoundError on delete of a missing criterion", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(store.delete("ghost")).rejects.toThrow(CriteriaNotFoundError);
  });

  it("throws CriteriaHasDependentsError carrying dependent ids on delete", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
      { projectId: "proj-test", id: "child", prompt: "c", dependsOn: ["parent"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(store.delete("parent")).rejects.toMatchObject({
      dependents: ["child"],
    });
    await expect(store.delete("parent")).rejects.toBeInstanceOf(
      CriteriaHasDependentsError,
    );
  });

  it("deletes a criterion that has no dependents", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "lonely", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await store.delete("lonely");
    expect(await store.get("lonely")).toBeNull();
  });
});

describe("CriteriaStore revives soft-deleted ids on re-create", () => {
  it("re-creating a soft-deleted id succeeds and returns a fresh active criterion", async () => {
    const col = fakeCollection([
      {
        id: "revive_me",
        projectId: "proj-test",
        prompt: "old",
        dependsOn: [],
        createdAt: new Date("2020-01-01"),
        updatedAt: new Date("2020-02-01"),
        deletedAt: new Date("2020-03-01"),
      },
    ]);
    const store = new CriteriaStore(col);

    const created = await store.create({ projectId: "proj-test", id: "revive_me", prompt: "new" });

    expect(created.prompt).toBe("new");
    expect((created as any).deletedAt).toBeUndefined();

    // It is now visible as an active criterion with the tombstone cleared.
    const fetched = await store.get("revive_me");
    expect(fetched).not.toBeNull();
    expect(fetched!.prompt).toBe("new");
    expect((fetched as any).deletedAt).toBeUndefined();
    expect((fetched as any).updatedAt).toBeUndefined();

    // No duplicate row was created — the tombstone was overwritten in place.
    expect(col._docs().filter((d: CriteriaDocument) => d.id === "revive_me")).toHaveLength(1);
  });

  it("still enforces validation when reviving (cycle rejected, tombstone untouched)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "a", prompt: "a", dependsOn: ["b"], createdAt: new Date() },
      {
        id: "b",
        projectId: "proj-test",
        prompt: "old",
        dependsOn: [],
        createdAt: new Date("2020-01-01"),
        deletedAt: new Date("2020-03-01"),
      },
    ]);
    const store = new CriteriaStore(col);

    // Reviving "b" with a dependency on "a" would form a cycle a->b->a.
    await expect(
      store.create({ projectId: "proj-test", id: "b", prompt: "new", dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);

    // The tombstone must remain soft-deleted and unchanged.
    const b = col._docs().find((d: CriteriaDocument) => d.id === "b")!;
    expect(b.deletedAt).toBeDefined();
    expect(b.prompt).toBe("old");
  });

  it("an active duplicate still throws CriteriaDuplicateError (not revived)", async () => {
    const col = fakeCollection([
      { projectId: "proj-test", id: "active", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await expect(store.create({ projectId: "proj-test", id: "active", prompt: "q" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });
});

