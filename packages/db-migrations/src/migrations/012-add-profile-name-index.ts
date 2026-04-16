// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add missing index on profiles.name for CosmosDB compatibility.
 *
 * CosmosDB's MongoDB API requires indexes for any field used in sort().
 * The list-profiles endpoint sorts by { name: 1 }, which causes a BadValue
 * error (code 2) without this index.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddProfileNameIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    try {
      await db.collection("profiles").createIndex({ name: 1 });
      console.log("  Created index on profiles.name");
    } catch (err: any) {
      console.log(
        `  Index on profiles.name already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
