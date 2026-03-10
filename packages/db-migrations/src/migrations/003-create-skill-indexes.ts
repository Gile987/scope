// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create indexes for skills and skill-revisions collections.
 *
 * Adds indexes for the Agent Skills feature. All `createIndex` calls are
 * idempotent — re-running is safe.
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

const SKILL_INDEXES: CollectionIndexes[] = [
  {
    collection: "skills",
    indexes: [
      { key: { createdAt: -1 } },
      { key: { source: 1, skillName: 1 } },
    ],
  },
  {
    collection: "skill-revisions",
    indexes: [
      { key: { ref: 1 }, options: { unique: true } },
      { key: { source: 1, skillName: 1 } },
      { key: { resolvedAt: -1 } },
    ],
  },
];

export class CreateSkillIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    for (const { collection, indexes } of SKILL_INDEXES) {
      const col = db.collection(collection);
      for (const { key, options } of indexes) {
        try {
          await col.createIndex(key, options ?? {});
          console.log(
            `  Created index ${JSON.stringify(key)} on ${collection}`,
          );
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
