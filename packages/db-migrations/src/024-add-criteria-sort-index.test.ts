// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

const { AddCriteriaSortIndex } = await import(
  "./migrations/024-add-criteria-sort-index.js"
);

function makeMockCollection() {
  const createIndex = vi.fn().mockResolvedValue("deletedAt_1_id_1");
  return { createIndex };
}

function makeMockDb() {
  const criteria = makeMockCollection();
  return {
    collection: vi.fn((name: string) => {
      if (name === "criteria") return criteria;
      throw new Error(`unexpected collection ${name}`);
    }),
    _criteria: criteria,
  } as unknown as Db & { _criteria: ReturnType<typeof makeMockCollection> };
}

describe("migration 024: AddCriteriaSortIndex", () => {
  describe("up()", () => {
    it("creates the compound { deletedAt: 1, id: 1 } index on criteria", async () => {
      const db = makeMockDb() as any;
      const migration = new AddCriteriaSortIndex();

      await migration.up(db);

      expect(db.collection).toHaveBeenCalledWith("criteria");
      expect(db._criteria.createIndex).toHaveBeenCalledTimes(1);
      expect(db._criteria.createIndex).toHaveBeenCalledWith({
        deletedAt: 1,
        id: 1,
      });
    });

    it("swallows createIndex errors (idempotent re-run)", async () => {
      const db = makeMockDb() as any;
      db._criteria.createIndex.mockRejectedValueOnce(
        Object.assign(new Error("index already exists"), { code: 85 }),
      );
      const migration = new AddCriteriaSortIndex();

      await expect(migration.up(db)).resolves.toBeUndefined();
    });
  });

  describe("down()", () => {
    it("is a no-op that does not drop indexes", async () => {
      const db = makeMockDb() as any;
      const migration = new AddCriteriaSortIndex();

      await expect(migration.down(db)).resolves.toBeUndefined();
      expect(db._criteria.createIndex).not.toHaveBeenCalled();
    });
  });
});
