// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Collection, Db } from "mongodb";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeObjectId(n: number) {
  return `id-${n}` as any;
}

/**
 * Build a mock Collection whose find() returns docs with the given ids,
 * and whose updateMany() resolves with { modifiedCount: batch.length }.
 */
function makeMockCollection(ids: any[] = [], updateManyImpl?: (filter: any, update: any) => any) {
  const mockFind = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      for (const id of ids) yield { _id: id };
    },
  });

  const mockUpdateMany = vi.fn().mockImplementation(async (filter: any) => {
    if (updateManyImpl) return updateManyImpl(filter, undefined);
    const count = filter._id?.$in?.length ?? 0;
    return { modifiedCount: count };
  });

  return { find: mockFind, updateMany: mockUpdateMany };
}

function makeMockDb(requestsIds: any[] = [], reportsIds: any[] = [], updateManyImpl?: any): Db {
  const reqCol = makeMockCollection(requestsIds, updateManyImpl);
  const repCol = makeMockCollection(reportsIds, updateManyImpl);
  return {
    collection: vi.fn((name: string) => (name === "requests" ? reqCol : repCol)),
    _requestsCol: reqCol,
    _reportsCol: repCol,
  } as any;
}

// ─── Import migration after helpers defined ────────────────────────────────

const { RemoveLogsFromDocs } = await import("./009-remove-logs-from-docs.js");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 009: RemoveLogsFromDocs", () => {
  describe("up()", () => {
    it("calls $unset logs on both requests and reports collections", async () => {
      const ids = [makeObjectId(1), makeObjectId(2)];
      const db = makeMockDb(ids, ids) as any;

      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      expect(db.collection).toHaveBeenCalledWith("requests");
      expect(db.collection).toHaveBeenCalledWith("reports");
      expect(db._requestsCol.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ids } },
        { $unset: { logs: "" } },
      );
      expect(db._reportsCol.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ids } },
        { $unset: { logs: "" } },
      );
    });

    it("does nothing when both collections have no documents with logs", async () => {
      const db = makeMockDb([], []) as any;
      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      expect(db._requestsCol.updateMany).not.toHaveBeenCalled();
      expect(db._reportsCol.updateMany).not.toHaveBeenCalled();
    });

    it("processes documents in batches of 10", async () => {
      // 25 documents → ceil(25/10) = 3 batches
      const ids = Array.from({ length: 25 }, (_, i) => makeObjectId(i));
      const db = makeMockDb(ids, []) as any;

      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      expect(db._requestsCol.updateMany).toHaveBeenCalledTimes(3);
      // First batch: 10, second: 10, third: 5
      expect(db._requestsCol.updateMany.mock.calls[0][0]._id.$in).toHaveLength(10);
      expect(db._requestsCol.updateMany.mock.calls[1][0]._id.$in).toHaveLength(10);
      expect(db._requestsCol.updateMany.mock.calls[2][0]._id.$in).toHaveLength(5);
    });

    it("retries a batch on CosmosDB 429 (code 16500) and succeeds on retry", async () => {
      const ids = [makeObjectId(1)];
      let callCount = 0;
      const updateManyImpl = () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error("TooManyRequests");
          err.code = 16500;
          err.retryAfterMs = 0; // no actual wait in tests
          throw err;
        }
        return { modifiedCount: 1 };
      };
      const db = makeMockDb(ids, []) as any;
      // Override the updateMany impl
      db._requestsCol.updateMany.mockImplementation(updateManyImpl);

      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      expect(db._requestsCol.updateMany).toHaveBeenCalledTimes(2);
    });

    it("throws if a non-429 error is encountered", async () => {
      const ids = [makeObjectId(1)];
      const db = makeMockDb(ids, []) as any;
      db._requestsCol.updateMany.mockRejectedValue(new Error("MongoNetworkError"));

      const migration = new RemoveLogsFromDocs();
      await expect(migration.up(db)).rejects.toThrow("MongoNetworkError");
    });
  });

  describe("down()", () => {
    it("is a no-op and does not throw", async () => {
      const db = makeMockDb() as any;
      const migration = new RemoveLogsFromDocs();
      await expect(migration.down(db)).resolves.toBeUndefined();
    });

    it("does not touch any collection", async () => {
      const db = makeMockDb() as any;
      const migration = new RemoveLogsFromDocs();
      await migration.down(db);
      expect(db.collection).not.toHaveBeenCalled();
    });
  });
});
