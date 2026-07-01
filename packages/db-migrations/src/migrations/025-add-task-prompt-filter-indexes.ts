// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add single-field indexes for the server-side-filterable
 * dimensions on the task-prompts collection (Prompt Library feature filter).
 *
 * The Prompt Library now evaluates every filter server-side, including a new
 * "Features" filter (prompts where all selected features are detected). Cosmos
 * DB for MongoDB (RU) recommends single-field indexes over compound indexes for
 * multi-property equality filters — it intersects them internally.
 *
 * Already present from earlier migrations (no-op here): createdAt.
 *
 * New here: type, deletedAt, features.featureId (multikey — features is an
 * array). Combined with the existing createdAt:-1 sort index, every filter on
 * the list query is index-backed.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const INDEXES: Array<{ key: Record<string, 1 | -1>; name: string }> = [
  { key: { type: 1 }, name: "type_1" },
  { key: { deletedAt: 1 }, name: "deletedAt_1" },
  { key: { "features.featureId": 1 }, name: "features.featureId_1" },
];

export class AddTaskPromptFilterIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("task-prompts");
    for (const { key, name } of INDEXES) {
      try {
        await col.createIndex(key);
        console.log(`[024] Created index ${name} on task-prompts`);
      } catch (err: any) {
        console.log(
          `[024] Index ${name} already exists or couldn't be created: ${err.message ?? err}`,
        );
      }
    }
  }

  async down(_db: Db): Promise<void> {
    console.log(
      "[024-down] Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
