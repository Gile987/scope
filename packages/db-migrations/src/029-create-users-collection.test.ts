// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { CreateUsersCollection } from "./migrations/029-create-users-collection.js";

function makeDb(createIndex: ReturnType<typeof vi.fn>): Db {
  return {
    collection: vi.fn(() => ({ createIndex })),
  } as unknown as Db;
}

describe("migration 029: CreateUsersCollection", () => {
  it("creates the required unique identity index and sparse email index", async () => {
    const createIndex = vi
      .fn()
      .mockResolvedValueOnce("uniq_identity")
      .mockResolvedValueOnce("email");

    await new CreateUsersCollection().up(makeDb(createIndex));

    expect(createIndex).toHaveBeenNthCalledWith(
      1,
      { idp: 1, idpTenant: 1, idpSubject: 1 },
      { unique: true, name: "uniq_identity" },
    );
    expect(createIndex).toHaveBeenNthCalledWith(
      2,
      { email: 1 },
      { sparse: true, name: "email" },
    );
  });

  it.each([
    Object.assign(
      new Error(
        "Forbidden (403): The unique index cannot be modified",
      ),
      { code: 13 },
    ),
    new Error("MongoNetworkError: connection interrupted"),
    Object.assign(new Error("not authorized to create index"), { code: 13 }),
  ])("propagates identity index creation failure: $message", async (error) => {
    const createIndex = vi.fn().mockRejectedValueOnce(error);

    await expect(
      new CreateUsersCollection().up(makeDb(createIndex)),
    ).rejects.toBe(error);
    expect(createIndex).toHaveBeenCalledTimes(1);
  });

  it("propagates email index creation failures", async () => {
    const error = new Error("MongoNetworkError: connection interrupted");
    const createIndex = vi
      .fn()
      .mockResolvedValueOnce("uniq_identity")
      .mockRejectedValueOnce(error);

    await expect(
      new CreateUsersCollection().up(makeDb(createIndex)),
    ).rejects.toBe(error);
    expect(createIndex).toHaveBeenCalledTimes(2);
  });
});
