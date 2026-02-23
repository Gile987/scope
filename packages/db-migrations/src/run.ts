// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration runner — discovers migration files, tracks state in `_migrations`
 * collection, and applies/reverts migrations in order.
 *
 * Usage:
 *   npx tsx src/run.ts up      # apply all pending migrations
 *   npx tsx src/run.ts down    # revert the last applied migration
 *   npx tsx src/run.ts status  # show migration status
 */

import { MongoClient, type Db } from "mongodb";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration, MigrationRecord } from "./types.js";

const MIGRATIONS_COLLECTION = "_migrations";

// Defaults match docker-compose.yml local dev environment
const DEFAULT_MONGO_URI = "mongodb://localhost:27117";
const DEFAULT_MONGO_DATABASE = "requests-db";

function getMongoUri(): string {
  return (
    process.env.MONGODB_URI ??
    process.env.MONGO_CONNECTION_STRING ??
    process.env.COSMOSDB_CONNECTION_STRING ??
    DEFAULT_MONGO_URI
  );
}

function getDbName(): string {
  return process.env.MONGODB_DATABASE ?? process.env.MONGO_DATABASE ?? DEFAULT_MONGO_DATABASE;
}

async function discoverMigrations(): Promise<{ name: string; path: string }[]> {
  const dir = join(fileURLToPath(import.meta.url), "..", "migrations");
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((f: string) => f.endsWith(".ts") || f.endsWith(".js"))
    .filter((f: string) => !f.endsWith(".d.ts"))
    .sort()
    .map((f: string) => ({ name: basename(f, f.endsWith(".ts") ? ".ts" : ".js"), path: join(dir, f) }));
}

async function loadMigration(path: string): Promise<Migration> {
  const mod = await import(path);
  const MigrationClass = mod.default ?? mod.Migration;
  if (!MigrationClass) {
    throw new Error(`Migration at ${path} must export a default class or named 'Migration' class`);
  }
  return new MigrationClass();
}

async function getApplied(db: Db): Promise<Map<string, MigrationRecord>> {
  const records = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find()
    .toArray();
  return new Map(records.map((r) => [r._id, r]));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function up(db: Db) {
  const migrations = await discoverMigrations();
  const applied = await getApplied(db);
  const pending = migrations.filter((m) => !applied.has(m.name));

  if (pending.length === 0) {
    console.log("✓ All migrations are up to date");
    return;
  }

  console.log(`Applying ${pending.length} migration(s)...\n`);
  for (const { name, path } of pending) {
    const migration = await loadMigration(path);
    console.log(`▸ ${name}: ${migration.description}`);
    await migration.up(db);
    await db.collection<MigrationRecord>(MIGRATIONS_COLLECTION).insertOne({
      _id: name,
      appliedAt: new Date(),
      description: migration.description,
    });
    console.log(`  ✓ applied\n`);
  }
  console.log("Done.");
}

async function down(db: Db) {
  const migrations = await discoverMigrations();
  const applied = await getApplied(db);

  // Find the last applied migration (by alphabetical order)
  const appliedMigrations = migrations.filter((m) => applied.has(m.name));
  if (appliedMigrations.length === 0) {
    console.log("✓ No migrations to revert");
    return;
  }

  const last = appliedMigrations[appliedMigrations.length - 1];
  const migration = await loadMigration(last.path);
  console.log(`Reverting ${last.name}: ${migration.description}`);
  await migration.down(db);
  await db.collection(MIGRATIONS_COLLECTION).deleteOne({ _id: last.name } as any);
  console.log("  ✓ reverted\n");
}

async function status(db: Db) {
  const migrations = await discoverMigrations();
  const applied = await getApplied(db);

  console.log("Migration status:\n");
  for (const { name } of migrations) {
    const record = applied.get(name);
    if (record) {
      console.log(`  ✓ ${name}  (applied ${record.appliedAt.toISOString()})`);
    } else {
      console.log(`  ○ ${name}  (pending)`);
    }
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  if (!command || !["up", "down", "status"].includes(command)) {
    console.error("Usage: npx tsx src/run.ts <up|down|status>");
    process.exit(1);
  }

  const client = new MongoClient(getMongoUri());
  try {
    await client.connect();
    const db = client.db(getDbName());
    console.log(`Connected to database: ${getDbName()}\n`);

    switch (command) {
      case "up":
        await up(db);
        break;
      case "down":
        await down(db);
        break;
      case "status":
        await status(db);
        break;
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
