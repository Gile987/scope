// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create sparse index on submissionId in the requests collection.
 *
 * Enables efficient filtering by submissionId. The index is sparse so it only
 * indexes documents that have the field, saving space for older records.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddSubmissionIdIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");
    try {
      await col.createIndex(
        { submissionId: 1 },
        { sparse: true },
      );
      console.log("  Created sparse index on requests.submissionId");
    } catch (err: any) {
      console.log(
        `  Index on requests.submissionId already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
