// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

function makeMockDb(createIndexImpl?: (...args: any[]) => any) {
  const createIndex = vi.fn(createIndexImpl ?? (async () => "experimentId_1"));
  const requests = { createIndex };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "requests") return requests;
      throw new Error(`unexpected collection ${name}`);
    }),
    _requests: requests,
  } as any;
  return db as Db & { _requests: { createIndex: ReturnType<typeof vi.fn> } };
}

const { AddExperimentIdIndex } = await import("./migrations/018-add-experiment-id-index.js");

describe("migration 018: AddExperimentIdIndex", () => {
  describe("up()", () => {
    it("creates a sparse single-field index on requests.experimentId", async () => {
      const db = makeMockDb();
      await new AddExperimentIdIndex().up(db);

      expect(db.collection).toHaveBeenCalledWith("requests");
      expect(db._requests.createIndex).toHaveBeenCalledTimes(1);
      expect(db._requests.createIndex).toHaveBeenCalledWith(
        { experimentId: 1 },
        { sparse: true },
      );
    });

    it("swallows errors when the index already exists", async () => {
      const db = makeMockDb(async () => {
        throw new Error("index already exists");
      });
      await expect(new AddExperimentIdIndex().up(db)).resolves.toBeUndefined();
    });
  });

  describe("down()", () => {
    it("does not drop the index (no-op)", async () => {
      const db = makeMockDb();
      await expect(new AddExperimentIdIndex().down(db)).resolves.toBeUndefined();
      expect(db._requests.createIndex).not.toHaveBeenCalled();
    });
  });
});
