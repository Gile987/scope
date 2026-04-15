// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RemoveLogsFromDocs } from "./013-remove-logs-from-docs.js";

// ─── Mock batch-update ────────────────────────────────────────────────────────

const mockBatchUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock("../batch-update.js", () => ({
  batchUpdate: mockBatchUpdate,
}));

// ─── Mock Db ──────────────────────────────────────────────────────────────────

function makeMockDb() {
  const requestsCollection = { name: "requests" };
  const reportsCollection = { name: "reports" };
  return {
    collection: vi.fn((name: string) => {
      if (name === "requests") return requestsCollection;
      if (name === "reports") return reportsCollection;
      throw new Error(`unexpected collection: ${name}`);
    }),
  } as any;
}

describe("013-remove-logs-from-docs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("up()", () => {
    it("unsets logs from requests collection", async () => {
      const db = makeMockDb();
      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      const requestsCall = mockBatchUpdate.mock.calls.find(
        ([col]) => col.name === "requests"
      );
      expect(requestsCall).toBeDefined();
      const [, filter, update] = requestsCall!;
      expect(filter).toEqual({ logs: { $exists: true } });
      expect(update).toEqual({ $unset: { logs: "" } });
    });

    it("unsets logs from reports collection", async () => {
      const db = makeMockDb();
      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      const reportsCall = mockBatchUpdate.mock.calls.find(
        ([col]) => col.name === "reports"
      );
      expect(reportsCall).toBeDefined();
      const [, filter, update] = reportsCall!;
      expect(filter).toEqual({ logs: { $exists: true } });
      expect(update).toEqual({ $unset: { logs: "" } });
    });

    it("calls batchUpdate twice (once per collection)", async () => {
      const db = makeMockDb();
      const migration = new RemoveLogsFromDocs();
      await migration.up(db);

      expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe("down()", () => {
    it("is a no-op and does not call batchUpdate", async () => {
      const db = makeMockDb();
      const migration = new RemoveLogsFromDocs();
      await migration.down(db);

      expect(mockBatchUpdate).not.toHaveBeenCalled();
    });
  });
});
