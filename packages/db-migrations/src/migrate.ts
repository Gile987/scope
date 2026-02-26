// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration CLI entry point — powered by mongo-migrate-ts.
 *
 * Usage:
 *   npx tsx src/migrate.ts up      # apply all pending migrations
 *   npx tsx src/migrate.ts down    # revert the last applied migration
 *   npx tsx src/migrate.ts status  # show migration status
 *   npx tsx src/migrate.ts new     # create a new migration file
 *
 * Connection defaults match docker-compose.yml local dev environment.
 * Override with MONGO_CONNECTION_STRING / MONGODB_URI and
 * MONGO_DATABASE / MONGODB_DATABASE env vars.
 */

import { mongoMigrateCli } from "mongo-migrate-ts";
import { MongoClient } from "mongodb";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const uri =
  process.env.MONGODB_URI ??
  process.env.MONGO_CONNECTION_STRING ??
  process.env.COSMOSDB_CONNECTION_STRING ??
  "mongodb://localhost:27000";

const database =
  process.env.MONGODB_DATABASE ??
  process.env.MONGO_DATABASE ??
  "requests-db";

const MIGRATIONS_COLLECTION = "_migrations";

/**
 * Bootstrap required indexes on the _migrations collection BEFORE
 * mongo-migrate-ts runs.
 *
 * Cosmos DB (MongoDB API) rejects sort operations on unindexed fields.
 * mongo-migrate-ts internally does `.sort({ timestamp: -1 })` to list and
 * find the last applied migration, so this index must exist before the
 * framework even checks migration status.
 *
 * This is a chicken-and-egg issue — we can't use a migration to create
 * the index because the framework can't read the migrations collection
 * without it.
 */
async function ensureMigrationsCollectionIndexes(): Promise<void> {
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db(database);
    const col = db.collection(MIGRATIONS_COLLECTION);
    await col.createIndex({ timestamp: -1 }).catch(() => {});
    await col.createIndex({ className: 1 }).catch(() => {});
    console.log(
      `Ensured indexes on ${MIGRATIONS_COLLECTION} collection`,
    );
  } finally {
    await client.close();
  }
}

await ensureMigrationsCollectionIndexes();

mongoMigrateCli({
  uri,
  database,
  migrationsDir: join(__dirname, "migrations"),
  migrationsCollection: MIGRATIONS_COLLECTION,
  globPattern: "**/*.ts",
});
