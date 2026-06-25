// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create indexes for codebases and codebase-revisions collections.
 *
 * Adds indexes for the first-class Codebases feature (#1110). All `createIndex`
 * calls are idempotent — re-running is safe. Index choices follow the
 * Cosmos DB for MongoDB guidance: single-field indexes for equality filters,
 * a focused 2-field compound for the revision-number sort.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

interface CollectionIndexes {
  collection: string;
  indexes: Array<{
    key: Record<string, 1 | -1>;
    options?: { unique?: boolean };
  }>;
}

const CODEBASE_INDEXES: CollectionIndexes[] = [
  {
    collection: "codebases",
    indexes: [
      { key: { slug: 1 }, options: { unique: true } },
      { key: { createdAt: -1 } },
      { key: { deletedAt: 1 } },
    ],
  },
  {
    collection: "codebase-revisions",
    indexes: [
      { key: { ref: 1 }, options: { unique: true } },
      { key: { codebaseId: 1 } },
      // 2-field compound serves getLatest / listByCodebase (sort by revisionNumber desc)
      { key: { codebaseId: 1, revisionNumber: -1 } },
    ],
  },
];

export class CreateCodebaseIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const { collection, indexes } of CODEBASE_INDEXES) {
      const col = db.collection(collection);
      for (const { key, options } of indexes) {
        try {
          await col.createIndex(key, options ?? {});
          console.log(`  Created index ${JSON.stringify(key)} on ${collection}`);
        } catch (err: any) {
          console.log(
            `  Index ${JSON.stringify(key)} on ${collection} already exists or couldn't be created: ${err.message ?? err}`,
          );
        }
      }
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
