// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach } from "vitest";
import { CriteriaStore } from "./criteria-store.js";
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
});
