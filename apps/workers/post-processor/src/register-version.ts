// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Standalone script run by the K8s Job on each deployment.
 * Writes the current post-processor version to MongoDB so the scheduler
 * can detect runs needing (re-)processing.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";
import { POST_PROCESSOR_VERSION } from "./version.js";

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
      { _id: "post-processor" } as any,
      { $set: { version: POST_PROCESSOR_VERSION, updatedAt: new Date() } },
      { upsert: true },
    );

  await mongo.close();
  console.log(`[register-version] Registered post-processor version: ${POST_PROCESSOR_VERSION}`);
}

main().catch((err) => {
  console.error("[register-version] Fatal error:", err);
  process.exit(1);
});
