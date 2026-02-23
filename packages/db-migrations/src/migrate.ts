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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const uri =
  process.env.MONGODB_URI ??
  process.env.MONGO_CONNECTION_STRING ??
  process.env.COSMOSDB_CONNECTION_STRING ??
  "mongodb://localhost:27117";

const database =
  process.env.MONGODB_DATABASE ??
  process.env.MONGO_DATABASE ??
  "requests-db";

mongoMigrateCli({
  uri,
  database,
  migrationsDir: join(__dirname, "migrations"),
  migrationsCollection: "_migrations",
  globPattern: "**/*.ts",
});
