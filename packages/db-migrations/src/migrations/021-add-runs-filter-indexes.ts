// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add single-field indexes for the newly server-side-filterable
 * dimensions on the requests collection (Runs list page, issue #1138).
 *
 * The Runs list now evaluates every filter server-side. Cosmos DB for MongoDB
 * (RU) recommends single-field indexes over compound indexes for multi-property
 * equality filters — it uses index intersection internally.
 *
 * Already present from earlier migrations (no-op here):
 *   taskPromptId, workerType, run.status, run.outcome, submissionId,
 *   createdAt, deletedAt, profileId.
 *
 * New here: model, run.os.platform, priority, agentVersion.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const INDEXES: Array<{ key: Record<string, 1 | -1>; name: string }> = [
  { key: { model: 1 }, name: "model_1" },
  { key: { "run.os.platform": 1 }, name: "run.os.platform_1" },
  { key: { priority: 1 }, name: "priority_1" },
  { key: { agentVersion: 1 }, name: "agentVersion_1" },
];

export class AddRunsFilterIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");
    for (const { key, name } of INDEXES) {
      try {
        await col.createIndex(key);
        console.log(`[021] Created index ${name} on requests`);
      } catch (err: any) {
        console.log(
          `[021] Index ${name} already exists or couldn't be created: ${err.message ?? err}`,
        );
      }
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[021-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
