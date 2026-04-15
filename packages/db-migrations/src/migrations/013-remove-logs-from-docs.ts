// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Remove logs array from requests and reports documents.
 *
 * Worker logs are now persisted as JSONL append blobs in Azure Blob Storage
 * (one file per requestId in the "logs" container). The logs array in MongoDB
 * is no longer written to, so existing documents should have it removed to
 * reclaim RU capacity and reduce document size.
 *
 * Uses cursor-based batching via batchUpdate to avoid CosmosDB 429 RU exhaustion.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";

export class RemoveLogsFromDocs implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const requests = db.collection("requests");
    const reports = db.collection("reports");

    await batchUpdate(
      requests,
      { logs: { $exists: true } },
      { $unset: { logs: "" } },
      "requests: unset logs",
    );

    await batchUpdate(
      reports,
      { logs: { $exists: true } },
      { $unset: { logs: "" } },
      "reports: unset logs",
    );
  }

  async down(_db: Db): Promise<void> {
    // No-op — log data has been migrated to blob storage and cannot be
    // restored to MongoDB from here.
  }
}
