// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration script: Split run status into status + outcome.
 *
 * Migrates existing runs:
 *   iterating  → status: "processing"  (no outcome)
 *   completed  → status: "done", outcome: "succeeded"
 *   failed     → status: "done", outcome: "failed"
 *   exhausted  → status: "done", outcome: "exhausted"
 *
 * Usage:
 *   npx tsx scripts/migrate-status-outcome.ts
 *
 * Environment:
 *   MONGO_URI       — MongoDB connection string (required)
 *   MONGO_DATABASE  — database name (default: "scope-mt")
 *   DRY_RUN         — set to "true" to preview without writing (default: false)
 */

import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DATABASE = process.env.MONGO_DATABASE || "scope-mt";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!MONGO_URI) {
  console.error("MONGO_URI environment variable is required");
  process.exit(1);
}

interface MigrationStep {
  label: string;
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
}

const steps: MigrationStep[] = [
  {
    label: 'iterating → processing',
    filter: { status: "iterating" },
    update: { $set: { status: "processing" }, $unset: { outcome: "" } },
  },
  {
    label: 'completed → done + succeeded',
    filter: { status: "completed" },
    update: { $set: { status: "done", outcome: "succeeded" } },
  },
  {
    label: 'failed → done + failed',
    filter: { status: "failed" },
    update: { $set: { status: "done", outcome: "failed" } },
  },
  {
    label: 'exhausted → done + exhausted',
    filter: { status: "exhausted" },
    update: { $set: { status: "done", outcome: "exhausted" } },
  },
];

async function main() {
  const client = new MongoClient(MONGO_URI!);
  try {
    await client.connect();
    const db = client.db(MONGO_DATABASE);
    const collection = db.collection("requests");

    console.log(`Database: ${MONGO_DATABASE}`);
    console.log(`Dry run: ${DRY_RUN}\n`);

    for (const step of steps) {
      const count = await collection.countDocuments(step.filter);
      console.log(`${step.label}: ${count} documents`);

      if (!DRY_RUN && count > 0) {
        const result = await collection.updateMany(step.filter, step.update);
        console.log(`  → modified: ${result.modifiedCount}`);
      }
    }

    console.log("\nMigration complete.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
