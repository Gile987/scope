// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration readiness check.
 *
 * Queries the `_migrations` collection to verify that every required
 * migration has been applied. Used by the API `/ready` endpoint so
 * Kubernetes holds traffic until the migration Job finishes.
 *
 * Results are cached for `CACHE_TTL_MS` to avoid hitting the database
 * on every probe interval.
 */

import type { Db } from "mongodb";
import { REQUIRED_MIGRATIONS } from "./required-migrations.js";

export interface MigrationCheckResult {
  /** True when all required migrations have been applied. */
  ready: boolean;
  /** Migrations that have been applied. */
  applied: string[];
  /** Migrations that are still pending. */
  pending: string[];
  /** Total number of migrations applied in the database (independent of REQUIRED_MIGRATIONS). */
  totalApplied: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds

let cachedResult: MigrationCheckResult | null = null;
let cachedAt = 0;

/**
 * Check whether all required migrations have been applied.
 * Returns a cached result if within the TTL window.
 */
export async function checkMigrations(db: Db): Promise<MigrationCheckResult> {
  const now = Date.now();
  if (cachedResult?.ready && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }
  // Even if not ready, cache briefly to avoid hammering DB on every probe
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const migrationsCol = db.collection("_migrations");

  // mongo-migrate-ts stores { file, className, timestamp } per migration
  const appliedDocs = await migrationsCol
    .find({}, { projection: { file: 1 } })
    .toArray();

  const appliedFiles = new Set(appliedDocs.map((d) => d.file as string));

  const applied: string[] = [];
  const pending: string[] = [];

  for (const file of REQUIRED_MIGRATIONS) {
    if (appliedFiles.has(file)) {
      applied.push(file);
    } else {
      pending.push(file);
    }
  }

  const result: MigrationCheckResult = {
    ready: pending.length === 0,
    applied,
    pending,
    totalApplied: appliedDocs.length,
  };

  cachedResult = result;
  cachedAt = now;

  return result;
}

/**
 * Reset the internal cache. Useful for testing.
 */
export function resetMigrationCheckCache(): void {
  cachedResult = null;
  cachedAt = 0;
}
