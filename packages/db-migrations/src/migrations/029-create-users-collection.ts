// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Create the `users` collection and its indexes.
 *
 * Backs API authentication (identity-only phase). Each user is keyed by the
 * IdP identity triple `(idp, idpTenant, idpSubject)`; the Scope User ID (`_id`)
 * is an app-owned UUID.
 *
 * - Unique compound `(idp, idpTenant, idpSubject)` — the durable identity key
 *   used by the JIT upsert lookup; guarantees one record per IdP principal.
 * - Sparse index on `email` — supports lookup/dedupe by email without
 *   indexing the many documents that may lack the (optional) field.
 *
 * All `createIndex` calls are idempotent and follow Cosmos DB for MongoDB
 * guidance. The collection is created implicitly by the first `createIndex`,
 * matching the pattern used by earlier migrations.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

const USERS_COLLECTION = "users";

export class CreateUsersCollection implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const users = db.collection(USERS_COLLECTION);

    // 1. Unique identity key — one record per (idp, idpTenant, idpSubject).
    try {
      await users.createIndex(
        { idp: 1, idpTenant: 1, idpSubject: 1 },
        { unique: true, name: "uniq_identity" },
      );
      console.log(
        "  Created unique index (idp, idpTenant, idpSubject) on users",
      );
    } catch (err: any) {
      console.log(
        `  Unique identity index on users already exists or couldn't be created: ${err.message ?? err}`,
      );
    }

    // 2. Sparse secondary index on email.
    try {
      await users.createIndex({ email: 1 }, { sparse: true, name: "email" });
      console.log("  Created sparse index on users.email");
    } catch (err: any) {
      console.log(
        `  Index on users.email already exists or couldn't be created: ${err.message ?? err}`,
      );
    }
  }

  async down(db: Db): Promise<void> {
    console.log(
      "  Skipping index/collection drop — drop manually if needed",
    );
  }
}