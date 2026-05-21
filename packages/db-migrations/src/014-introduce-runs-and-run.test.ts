// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

const { IntroduceRunsAndRun } = await import("./migrations/014-introduce-runs-and-run.js");
const { buildRunReshapeUpdate, buildRunUnshapeUpdate } = await import("./014-helpers.js");

describe("buildRunReshapeUpdate", () => {
  it("nests per-attempt fields under run with attemptNumber=1", () => {
    const doc = {
      _id: "req-1",
      scenario: { task: "test" },             // top-level config — not touched
      workerType: "coder-acp-copilot",
      status: "done",
      outcome: "succeeded",
      result: "ok",
      turns: [{ iteration: 1 }],
      harUrl: "https://example.com/h.har",
      videoUrls: ["https://example.com/v.webm"],
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      aiCallCount: 4,
      workerVersion: "wv",
      os: { platform: "linux", release: "5", arch: "x64" },
      updatedAt: new Date("2026-04-20T00:00:00Z"),
    };

    const { $set, $unset } = buildRunReshapeUpdate(doc);

    expect($set.run._id).toBe("req-1");
    expect($set.run.attemptNumber).toBe(1);
    expect($set.run.status).toBe("done");
    expect($set.run.outcome).toBe("succeeded");
    expect($set.run.result).toBe("ok");
    expect($set.run.turns).toEqual([{ iteration: 1 }]);
    expect($set.run.harUrl).toBe("https://example.com/h.har");
    expect($set.run.videoUrls).toEqual(["https://example.com/v.webm"]);
    expect($set.run.tokenUsage.totalTokens).toBe(3);
    expect($set.run.aiCallCount).toBe(4);
    expect($set.run.workerVersion).toBe("wv");
    expect($set.run.os.platform).toBe("linux");

    // $unset removes the now-nested fields from the top level
    expect($unset.status).toBe("");
    expect($unset.outcome).toBe("");
    expect($unset.turns).toBe("");
    expect($unset.harUrl).toBe("");
    expect($unset.videoUrls).toBe("");
    expect($unset.tokenUsage).toBe("");
  });

  it("omits fields that are undefined on the source doc", () => {
    const doc = {
      _id: "req-2",
      status: "done",
      outcome: "failed",
      error: "boom",
    };
    const { $set } = buildRunReshapeUpdate(doc);
    expect($set.run.harUrl).toBeUndefined();
    expect($set.run.turns).toBeUndefined();
    expect($set.run.videoUrls).toBeUndefined();
    expect($set.run.error).toBe("boom");
  });

  it("marks pending requests as failed (abandoned during migration)", () => {
    const doc = { _id: "req-3", status: "pending" };
    const { $set } = buildRunReshapeUpdate(doc);

    expect($set.run.status).toBe("done");
    expect($set.run.outcome).toBe("failed");
    expect($set.run.error).toMatch(/abandoned/i);
    expect($set.run.finishedAt).toBeInstanceOf(Date);
  });

  it("marks processing requests as failed (abandoned during migration)", () => {
    const doc = { _id: "req-4", status: "processing" };
    const { $set } = buildRunReshapeUpdate(doc);

    expect($set.run.status).toBe("done");
    expect($set.run.outcome).toBe("failed");
    expect($set.run.error).toMatch(/abandoned/i);
  });

  it("defaults missing status to done", () => {
    const doc = { _id: "req-5" };
    const { $set } = buildRunReshapeUpdate(doc);
    expect($set.run.status).toBe("done");
  });
});

describe("buildRunUnshapeUpdate", () => {
  it("lifts run.* fields back to the top level and drops run", () => {
    const doc = {
      _id: "req-1",
      run: {
        _id: "req-1",
        attemptNumber: 2,
        status: "done",
        outcome: "succeeded",
        turns: [{ iteration: 1 }],
        harUrl: "https://example.com/h.har",
      },
    };

    const { $set, $unset } = buildRunUnshapeUpdate(doc);

    expect($set.status).toBe("done");
    expect($set.outcome).toBe("succeeded");
    expect($set.turns).toEqual([{ iteration: 1 }]);
    expect($set.harUrl).toBe("https://example.com/h.har");
    expect($unset.run).toBe("");
    expect($unset.attemptCount).toBe("");
  });

  it("handles a doc with no run field (idempotency)", () => {
    const doc = { _id: "req-2" };
    const { $set, $unset } = buildRunUnshapeUpdate(doc);
    expect($set).toEqual({});
    expect($unset.run).toBe("");
    expect($unset.attemptCount).toBe("");
  });
});

// ─── End-to-end migration up()/down() with mocked Db ──────────────────────

function makeMockCursor(docs: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const d of docs) yield d;
    },
  };
}

function makeMockCollection(docs: any[] = []) {
  const updateOne = vi.fn().mockImplementation(async (filter: any, update: any) => ({
    modifiedCount: 1,
    filter,
    update,
  }));
  const bulkWrite = vi.fn().mockImplementation(async (ops: any[]) => ({
    modifiedCount: ops.length,
  }));
  const dropIndex = vi.fn().mockResolvedValue({});
  const createIndex = vi.fn().mockResolvedValue("idx");
  const find = vi.fn().mockReturnValue(makeMockCursor(docs));
  return {
    find,
    updateOne,
    bulkWrite,
    dropIndex,
    createIndex,
    _docs: docs,
  };
}

function makeMockDb(requestsDocs: any[] = [], options: { runsExists?: boolean } = {}) {
  const requests = makeMockCollection(requestsDocs);
  const runs = makeMockCollection([]);
  const createCollection = vi.fn().mockImplementation(async (name: string) => {
    if (name === "runs" && options.runsExists) {
      const err: any = new Error("collection already exists");
      err.code = 48;
      throw err;
    }
    return runs;
  });
  const dropCollection = vi.fn().mockResolvedValue(true);
  return {
    collection: vi.fn((name: string) => (name === "requests" ? requests : runs)),
    createCollection,
    dropCollection,
    _requests: requests,
    _runs: runs,
  } as unknown as Db;
}

describe("migration 014: IntroduceRunsAndRun", () => {
  describe("up()", () => {
    it("reshapes each request and creates runs collection + indexes", async () => {
      const db = makeMockDb([
        { _id: "req-1", status: "done", outcome: "succeeded", turns: [{ iteration: 1 }] },
        { _id: "req-2", status: "done", outcome: "failed", error: "boom" },
      ]) as any;

      const migration = new IntroduceRunsAndRun();
      await migration.up(db);

      // bulkWrite called once (both docs fit in a single batch of 25)
      expect(db._requests.bulkWrite).toHaveBeenCalledTimes(1);
      const ops = db._requests.bulkWrite.mock.calls[0][0];
      expect(ops).toHaveLength(2);
      expect(ops[0].updateOne.filter._id).toBe("req-1");
      expect(ops[1].updateOne.filter._id).toBe("req-2");

      // Drops old flat indexes and creates nested-path replacements
      expect(db._requests.dropIndex).toHaveBeenCalledWith("status_1");
      expect(db._requests.dropIndex).toHaveBeenCalledWith("outcome_1");
      expect(db._requests.createIndex).toHaveBeenCalledWith({ "run.status": 1 });
      expect(db._requests.createIndex).toHaveBeenCalledWith({ "run.outcome": 1 });

      // Creates runs collection + indexes
      expect(db.createCollection).toHaveBeenCalledWith("runs");
      expect(db._runs.createIndex).toHaveBeenCalledWith({ requestId: 1 });
      expect(db._runs.createIndex).toHaveBeenCalledWith({
        requestId: 1,
        attemptNumber: -1,
      });
    });

    it("is a no-op for the document scan when no requests need reshaping", async () => {
      const db = makeMockDb([]) as any;
      const migration = new IntroduceRunsAndRun();
      await migration.up(db);

      expect(db._requests.bulkWrite).not.toHaveBeenCalled();
      // Indexes are still managed
      expect(db._requests.dropIndex).toHaveBeenCalled();
      expect(db._requests.createIndex).toHaveBeenCalled();
    });

    it("survives runs collection already existing", async () => {
      const db = makeMockDb([], { runsExists: true }) as any;
      const migration = new IntroduceRunsAndRun();
      await expect(migration.up(db)).resolves.toBeUndefined();
      expect(db._runs.createIndex).toHaveBeenCalled();
    });
  });

  describe("down()", () => {
    it("lifts run.* back to top level, restores indexes, drops runs", async () => {
      const db = makeMockDb([
        {
          _id: "req-1",
          run: {
            _id: "req-1",
            attemptNumber: 1,
            status: "done",
            outcome: "succeeded",
          },

        },
      ]) as any;

      const migration = new IntroduceRunsAndRun();
      await migration.down(db);

      expect(db._requests.bulkWrite).toHaveBeenCalledTimes(1);
      const ops = db._requests.bulkWrite.mock.calls[0][0];
      expect(ops).toHaveLength(1);
      const update = ops[0].updateOne.update;
      expect(update.$unset.run).toBe("");
      expect(update.$unset.attemptCount).toBe("");
      expect(update.$set.status).toBe("done");

      expect(db._requests.dropIndex).toHaveBeenCalledWith("run.status_1");
      expect(db._requests.dropIndex).toHaveBeenCalledWith("run.outcome_1");
      expect(db._requests.createIndex).toHaveBeenCalledWith({ status: 1 });
      expect(db._requests.createIndex).toHaveBeenCalledWith({ outcome: 1 });

      expect(db.dropCollection).toHaveBeenCalledWith("runs");
    });

    it("retries on Cosmos 429 throttle errors", async () => {
      const db = makeMockDb([
        { _id: "req-1", status: "done", outcome: "succeeded" },
      ]) as any;

      const throttleErr: any = new Error("TooManyRequests");
      throttleErr.code = 16500;
      throttleErr.errorResponse = { RetryAfterMs: 1 };

      // First call throws 429, second succeeds
      db._requests.bulkWrite
        .mockRejectedValueOnce(throttleErr)
        .mockResolvedValueOnce({ modifiedCount: 1 });

      const migration = new IntroduceRunsAndRun();
      await migration.up(db);

      expect(db._requests.bulkWrite).toHaveBeenCalledTimes(2);
    });
  });
});
