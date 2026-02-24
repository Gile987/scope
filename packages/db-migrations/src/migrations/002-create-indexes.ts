// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create all collection indexes.
 *
 * Moves index creation from API startup into a one-time migration so that
 * indexes are tracked as discrete versioned events and not re-issued on
 * every pod restart.
 *
 * All `createIndex` calls are idempotent — re-running is safe.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

/** Index definition for a single collection. */
interface CollectionIndexes {
  collection: string;
  indexes: Array<{
    key: Record<string, 1 | -1>;
    options?: { unique?: boolean };
  }>;
}

const ALL_INDEXES: CollectionIndexes[] = [
  {
    collection: "requests",
    indexes: [{ key: { createdAt: -1 } }],
  },
  {
    collection: "task-prompts",
    indexes: [{ key: { createdAt: -1 } }],
  },
  {
    collection: "criteria",
    indexes: [{ key: { id: 1 }, options: { unique: true } }],
  },
  {
    collection: "prompt-features",
    indexes: [{ key: { id: 1 }, options: { unique: true } }],
  },
  {
    collection: "prompt-feature-extractions",
    indexes: [{ key: { taskTextHash: 1 }, options: { unique: true } }],
  },
  {
    collection: "reports",
    indexes: [{ key: { createdAt: -1 } }, { key: { requestId: 1 } }],
  },
  {
    collection: "agents",
    indexes: [{ key: { createdAt: -1 } }],
  },
  {
    collection: "models",
    indexes: [
      { key: { agentId: 1 } },
      { key: { provider: 1 } },
      { key: { agentId: 1, provider: 1 } },
      { key: { modelId: 1 } },
    ],
  },
  {
    collection: "insights",
    indexes: [{ key: { createdAt: -1 } }],
  },
  {
    collection: "mcp-servers",
    indexes: [{ key: { createdAt: -1 } }],
  },
  {
    collection: "feature-flags",
    indexes: [{ key: { key: 1 }, options: { unique: true } }],
  },
];

export class CreateIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const { collection, indexes } of ALL_INDEXES) {
      const col = db.collection(collection);
      for (const { key, options } of indexes) {
        try {
          await col.createIndex(key, options ?? {});
          console.log(
            `  Created index ${JSON.stringify(key)} on ${collection}`,
          );
        } catch (err: any) {
          // Cosmos DB returns code 85 (IndexOptionsConflict) when the index
          // already exists. Regular MongoDB silently no-ops.
          console.log(
            `  Index ${JSON.stringify(key)} on ${collection} already exists or couldn't be created: ${err.message ?? err}`,
          );
        }
      }
    }
  }

  async down(db: Db): Promise<void> {
    // Dropping indexes is destructive and would degrade query performance.
    // Intentionally left as a no-op — indexes should be dropped manually
    // if truly needed.
    console.log(
      "  Skipping index removal — drop indexes manually if needed.",
    );
  }
}
