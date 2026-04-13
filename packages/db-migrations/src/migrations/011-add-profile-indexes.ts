// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Add indexes for the profile feature.
 *
 * - requests.profileId (sparse) — supports group-by-profile aggregation
 *   and filtering runs by profile. Sparse because older runs lack the field.
 * - profiles.createdAt — standard time-ordered listing index.
 * - profile-versions compound (profileId, version desc) — efficient lookup
 *   of the latest version for a given profile.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class AddProfileIndexes implements MigrationInterface {
  async up(db: Db): Promise<void> {
    // 1. Sparse index on requests.profileId
    try {
      await db.collection("requests").createIndex(
        { profileId: 1 },
        { sparse: true },
      );
      console.log("  Created sparse index on requests.profileId");
    } catch (err: any) {
      console.log(
        `  Index on requests.profileId already exists or couldn't be created: ${err.message ?? err}`,
      );
    }

    // 2. Index on profiles.createdAt
    try {
      await db.collection("profiles").createIndex({ createdAt: -1 });
      console.log("  Created index on profiles.createdAt");
    } catch (err: any) {
      console.log(
        `  Index on profiles.createdAt already exists or couldn't be created: ${err.message ?? err}`,
      );
    }

    // 3. Compound index on profile-versions (profileId + version desc)
    try {
      await db.collection("profile-versions").createIndex(
        { profileId: 1, version: -1 },
      );
      console.log("  Created compound index on profile-versions (profileId, version)");
    } catch (err: any) {
      console.log(
        `  Index on profile-versions already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index drop — indexes should be dropped manually if needed",
    );
  }
}
