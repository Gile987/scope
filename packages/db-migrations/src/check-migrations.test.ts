// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMigrations,
  resetMigrationCheckCache,
  type MigrationCheckResult,
} from "./check-migrations.js";

// Mock Db
function makeMockDb(appliedFiles: string[]) {
  const docs = appliedFiles.map((file) => ({
    file,
    className: file.replace(".ts", ""),
    timestamp: Date.now(),
  }));
  return {
    collection: vi.fn().mockReturnValue({
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(docs),
      }),
    }),
  } as any;
}

describe("checkMigrations", () => {
  beforeEach(() => {
    resetMigrationCheckCache();
  });

  it("returns ready when all required migrations are applied", async () => {
    const db = makeMockDb([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
      "005-backfill-iteration-durations.ts",
      "006-split-status-outcome.ts",
      "007-rename-exhausted-to-finished.ts",
      "008-backfill-ai-call-count.ts",
      "009-add-requests-filter-indexes.ts",
      "010-add-requests-pagination-index.ts",
      "011-add-profile-indexes.ts",
      "012-add-profile-name-index.ts",
    ]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
    expect(result.applied).toEqual([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
      "005-backfill-iteration-durations.ts",
      "006-split-status-outcome.ts",
      "007-rename-exhausted-to-finished.ts",
      "008-backfill-ai-call-count.ts",
      "009-add-requests-filter-indexes.ts",
      "010-add-requests-pagination-index.ts",
      "011-add-profile-indexes.ts",
      "012-add-profile-name-index.ts",
    ]);
  });

  it("returns not ready when migrations are missing", async () => {
    const db = makeMockDb(["001-backfill-task-prompts.ts"]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual(["002-create-indexes.ts", "003-create-skill-indexes.ts", "004-add-submission-id-index.ts", "005-backfill-iteration-durations.ts", "006-split-status-outcome.ts", "007-rename-exhausted-to-finished.ts", "008-backfill-ai-call-count.ts", "009-add-requests-filter-indexes.ts", "010-add-requests-pagination-index.ts", "011-add-profile-indexes.ts", "012-add-profile-name-index.ts"]);
    expect(result.applied).toEqual(["001-backfill-task-prompts.ts"]);
  });

  it("returns not ready when no migrations are applied", async () => {
    const db = makeMockDb([]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(false);
    expect(result.pending).toEqual([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
      "005-backfill-iteration-durations.ts",
      "006-split-status-outcome.ts",
      "007-rename-exhausted-to-finished.ts",
      "008-backfill-ai-call-count.ts",
      "009-add-requests-filter-indexes.ts",
      "010-add-requests-pagination-index.ts",
      "011-add-profile-indexes.ts",
      "012-add-profile-name-index.ts",
    ]);
    expect(result.applied).toEqual([]);
  });

  it("ignores extra applied migrations not in the required list", async () => {
    const db = makeMockDb([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
      "005-backfill-iteration-durations.ts",
      "006-split-status-outcome.ts",
      "007-rename-exhausted-to-finished.ts",
      "008-backfill-ai-call-count.ts",
      "009-add-requests-filter-indexes.ts",
      "010-add-requests-pagination-index.ts",
      "011-add-profile-indexes.ts",
      "012-add-profile-name-index.ts",
      "999-future-migration.ts",
    ]);
    const result = await checkMigrations(db);
    expect(result.ready).toBe(true);
    expect(result.pending).toEqual([]);
  });

  it("caches results within TTL", async () => {
    const db = makeMockDb([
      "001-backfill-task-prompts.ts",
      "002-create-indexes.ts",
      "003-create-skill-indexes.ts",
      "004-add-submission-id-index.ts",
    ]);
    const result1 = await checkMigrations(db);
    const result2 = await checkMigrations(db);

    expect(result1).toBe(result2); // same reference = cached
    // find() should only have been called once
    expect(db.collection).toHaveBeenCalledTimes(1);
  });

  it("queries _migrations collection", async () => {
    const db = makeMockDb([]);
    await checkMigrations(db);
    expect(db.collection).toHaveBeenCalledWith("_migrations");
  });
});
