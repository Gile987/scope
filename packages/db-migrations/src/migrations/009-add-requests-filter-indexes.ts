// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add single-field indexes for commonly filtered fields on the
 * requests collection.
 *
 * The server-side grouping and filtering pipeline uses $match on these fields.
 * Cosmos DB for MongoDB (RU) recommends single-field indexes over compound
 * indexes for multi-property filters — it uses index intersection internally.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const INDEXES: Array<{ key: Record<string, 1 | -1>; name: string }> = [
  { key: { taskPromptId: 1 }, name: "taskPromptId_1" },
  { key: { status: 1 }, name: "status_1" },
  { key: { outcome: 1 }, name: "outcome_1" },
  { key: { workerType: 1 }, name: "workerType_1" },
  { key: { deletedAt: 1 }, name: "deletedAt_1" },
];

export class AddRequestsFilterIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");
    for (const { key, name } of INDEXES) {
      try {
        await col.createIndex(key);
        console.log(`  Created index ${name} on requests`);
      } catch (err: any) {
        console.log(
          `  Index ${name} already exists or couldn't be created: ${err.message ?? err}`,
        );
      }
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
