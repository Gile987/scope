// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create a sparse index on experimentId in the requests collection.
 *
 * GEPA optimizer runs group a seed request and all follow-up (mutation/merge)
 * requests under a shared `experimentId`. Both experiment grouping
 * (`groupBy=experiment`) and AGENTS.md lineage reconstruction filter requests
 * by this field, so a single-field index keeps those queries efficient.
 *
 * The index is sparse so it only indexes documents that actually carry an
 * `experimentId` (most requests don't), avoiding write-RU cost on the rest.
 * No other indexes are needed: the new `type` fields on task-prompts /
 * prompt-features are tiny, human-curated collections where `?type=` scans are
 * cheap, and request lineage is stored inline on the request
 * (`agentsMdParentIds`) and queried via this same experimentId index.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddExperimentIdIndex implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection("requests");
    try {
      await col.createIndex({ experimentId: 1 }, { sparse: true });
      console.log("  Created sparse index on requests.experimentId");
    } catch (err: any) {
      console.log(
        `  Index on requests.experimentId already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
