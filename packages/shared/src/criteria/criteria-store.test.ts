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
      docs.push({ ...doc });
      return { insertedId: doc.id };
    },
    async updateOne(filter: any, update: any) {
      const doc = docs.find((d) => matches(d, filter));
      if (doc && update.$set) Object.assign(doc, update.$set);
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
      { id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ id: "child", prompt: "c", dependsOn: ["parent"], gates: ["build"] }),
    ).resolves.toMatchObject({ id: "child", gates: ["build"] });
  });

  it("rejects a child compatible with a gate its parent is not", async () => {
    const col = fakeCollection([
      { id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"] }),
    ).rejects.toThrow(/not/i);
  });

  it("rejects an unrestricted child of a restricted parent", async () => {
    const col = fakeCollection([
      { id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // No gates on child => universal (all gates) => must fail against select-only parent.
    await expect(
      store.create({ id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).rejects.toThrow();
  });

  it("allows an unrestricted child of an unrestricted parent", async () => {
    const col = fakeCollection([
      { id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ id: "child", prompt: "c", dependsOn: ["parent"] }),
    ).resolves.toMatchObject({ id: "child" });
  });

  it("enforces the invariant on update too", async () => {
    const col = fakeCollection([
      { id: "parent", prompt: "p", dependsOn: [], gates: ["select"], createdAt: new Date() },
      { id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.update("child", { gates: ["select", "build"] as GateId[] }),
    ).rejects.toThrow();
  });

  it("rejects narrowing a parent below an existing dependent's gates (parent side)", async () => {
    const col = fakeCollection([
      { id: "parent", prompt: "p", dependsOn: [], gates: ["select", "build"], createdAt: new Date() },
      { id: "child", prompt: "c", dependsOn: ["parent"], gates: ["select", "build"], createdAt: new Date() },
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
      { id: "a", prompt: "a", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    await expect(
      store.create({ id: "b", prompt: "b", dependsOn: ["a"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a transitive cycle on update", async () => {
    const col = fakeCollection([
      { id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
      { id: "b", prompt: "b", dependsOn: ["a"], createdAt: new Date() },
      { id: "c", prompt: "c", dependsOn: ["b"], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);

    // a -> b -> c already; making a depend on c closes the loop a->c->b->a.
    await expect(
      store.update("a", { dependsOn: ["c"] }),
    ).rejects.toThrow(CriteriaValidationError);
  });

  it("rejects a self-reference", async () => {
    const col = fakeCollection([
      { id: "a", prompt: "a", dependsOn: [], createdAt: new Date() },
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
    await expect(store.create({ id: "Bad-Id", prompt: "p" })).rejects.toThrow(
      CriteriaValidationError,
    );
  });

  it("throws CriteriaDuplicateError when the id already exists", async () => {
    const col = fakeCollection([
      { id: "dup", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await expect(store.create({ id: "dup", prompt: "p" })).rejects.toThrow(
      CriteriaDuplicateError,
    );
  });

  it("throws CriteriaValidationError when a dependency does not exist", async () => {
    const store = new CriteriaStore(fakeCollection());
    await expect(
      store.create({ id: "a", prompt: "p", dependsOn: ["missing"] }),
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
      { id: "parent", prompt: "p", dependsOn: [], createdAt: new Date() },
      { id: "child", prompt: "c", dependsOn: ["parent"], createdAt: new Date() },
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
      { id: "lonely", prompt: "p", dependsOn: [], createdAt: new Date() },
    ]);
    const store = new CriteriaStore(col);
    await store.delete("lonely");
    expect(await store.get("lonely")).toBeNull();
  });
});
