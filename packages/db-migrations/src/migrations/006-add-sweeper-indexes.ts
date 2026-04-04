// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add compound indexes for the stale-run sweeper on the requests collection.
 *
 * These indexes support the sweeper queries that find stuck documents:
 * - { status, heartbeatAt } — primary sweep: find docs with stale heartbeat
 * - { status, updatedAt }   — legacy fallback: find pre-heartbeat docs by updatedAt
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddSweeperIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");

    // Compound index for primary heartbeat-based sweep
    try {
      await col.createIndex(
        { status: 1, heartbeatAt: 1 },
      );
      console.log("  Created compound index on requests.{status, heartbeatAt}");
    } catch (err: any) {
      console.log(
        `  Index on requests.{status, heartbeatAt} already exists or couldn't be created: ${err.message ?? err}`,
      );
    }

    // Compound index for legacy updatedAt-based fallback sweep
    try {
      await col.createIndex(
        { status: 1, updatedAt: 1 },
      );
      console.log("  Created compound index on requests.{status, updatedAt}");
    } catch (err: any) {
      console.log(
        `  Index on requests.{status, updatedAt} already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
