// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Mock a `criteria` collection. `find()` yields the supplied ids (the rows the
 * broadened filter is expected to match) and `updateMany()` reports a
 * modifiedCount equal to the batch size.
 */
function makeMockCriteria(ids: any[] = []) {
  const find = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      for (const id of ids) yield { _id: id };
    },
  });
  const updateMany = vi.fn().mockImplementation(async (filter: any) => ({
    modifiedCount: filter._id?.$in?.length ?? 0,
  }));
  return { find, updateMany };
}

function makeMockDb(criteria: ReturnType<typeof makeMockCriteria>): Db {
  return {
    collection: vi.fn(() => criteria),
  } as any;
}

const { BackfillCriteriaGates } = await import("./migrations/018-backfill-criteria-gates.js");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 018: BackfillCriteriaGates", () => {
  describe("up()", () => {
    it("matches criteria whose gates are absent, empty, or null", async () => {
      const criteria = makeMockCriteria(["a", "b"]);
      const db = makeMockDb(criteria);

      await new BackfillCriteriaGates().up(db);

      expect(db.collection).toHaveBeenCalledWith("criteria");
      const [filter] = criteria.find.mock.calls[0];
      expect(filter).toEqual({
        $or: [{ gates: { $exists: false } }, { gates: { $size: 0 } }, { gates: null }],
      });
    });

    it("sets gates to [select] on the matched rows", async () => {
      const criteria = makeMockCriteria(["a"]);
      const db = makeMockDb(criteria);

      await new BackfillCriteriaGates().up(db);

      const [, update] = criteria.updateMany.mock.calls[0];
      expect(update).toEqual({ $set: { gates: ["select"] } });
    });

    it("does nothing when no rows match", async () => {
      const criteria = makeMockCriteria([]);
      const db = makeMockDb(criteria);

      await new BackfillCriteriaGates().up(db);

      expect(criteria.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("unsets gates only on rows that are exactly [select]", async () => {
      const criteria = makeMockCriteria(["a"]);
      const db = makeMockDb(criteria);

      await new BackfillCriteriaGates().down(db);

      const [filter] = criteria.find.mock.calls[0];
      expect(filter).toEqual({ gates: ["select"] });
      const [, update] = criteria.updateMany.mock.calls[0];
      expect(update).toEqual({ $unset: { gates: "" } });
    });
  });
});
