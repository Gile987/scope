// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add compound index for cursor-based pagination on the requests
 * collection.
 *
 * The paginated runs list sorts by `{ createdAt: -1, _id: -1 }` and uses
 * cursor conditions on both fields. Cosmos DB for MongoDB requires an explicit
 * composite index for multi-field sort — without it the query returns:
 *
 *   "The order by query does not have a corresponding composite index
 *    that it can be served from."
 *
 * Both ascending and descending variants are created because backward
 * pagination reverses the sort to `{ createdAt: 1, _id: 1 }`.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddRequestsPaginationIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    const indexes = [
      { key: { createdAt: -1 as const, _id: -1 as const }, name: "createdAt_-1__id_-1" },
      { key: { createdAt: 1 as const, _id: 1 as const }, name: "createdAt_1__id_1" },
    ];

    for (const { key, name } of indexes) {
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
