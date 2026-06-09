// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Standalone script run by the K8s Job on each deployment.
 * Registers the report-generator handler in the services collection
 * with its version, queue, and dependency information so the scheduler
 * can orchestrate the DAG-based post-processing pipeline.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const REPORT_HANDLER_VERSION = 1;

const MONGO_URI =
  process.env.MONGO_CONNECTION_STRING ||
  process.env.AZURE_COSMOS_CONNECTION_STRING ||
  "mongodb://localhost:27017";
const MONGO_DATABASE = process.env.MONGO_DATABASE || "requests-db";

async function main(): Promise<void> {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();

  await mongo
    .db(MONGO_DATABASE)
    .collection("services")
    .updateOne(
      { _id: "pp-report" } as any,
      {
        $set: {
          type: "post-process-handler",
          version: REPORT_HANDLER_VERSION,
          queue: "report-queue",
          selector: "report",
          autoBackfill: false,
          dependsOn: ["pp-atif", "pp-taxonomy"],
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

  await mongo.close();
  console.log(`[register-version] Registered pp-report handler version: ${REPORT_HANDLER_VERSION}`);
}

main().catch((err) => {
  console.error("[register-version] Fatal error:", err);
  process.exit(1);
});
