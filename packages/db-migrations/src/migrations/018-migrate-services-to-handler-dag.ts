// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

/**
 * Migration 018: Remove the legacy "post-processor" service entry.
 *
 * Handler service registration (pp-atif, pp-taxonomy, pp-report) is now owned
 * by each worker's register-version.ts script, run as a K8s Job on deploy.
 * This migration only cleans up the old single-entry format.
 */
export class MigrateServicesToHandlerDag implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const services = db.collection("services");
    await services.deleteOne({ _id: "post-processor" } as any);
    console.log("[018] Deleted legacy post-processor service entry (handler registration now owned by workers)");
  }

  async down(db: Db): Promise<void> {
    const services = db.collection("services");
    await services.updateOne(
      { _id: "post-processor" } as any,
      {
        $set: { version: 2 },
        $unset: {
          type: "",
          queue: "",
          selector: "",
          autoBackfill: "",
          dependsOn: "",
        },
      },
      { upsert: true },
    );
    console.log("[018-down] Restored legacy post-processor service entry");
  }
}
