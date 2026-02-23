// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Lightweight MongoDB migration framework.
 *
 * Each migration is a file in the `migrations/` directory that exports a
 * class implementing the `Migration` interface. Migrations are applied in
 * alphabetical order and tracked in a `_migrations` collection.
 */

import { type Db } from "mongodb";

/** Interface every migration must implement. */
export interface Migration {
  /** Human-readable description shown in status output. */
  description: string;
  /** Apply the migration. */
  up(db: Db): Promise<void>;
  /** Revert the migration (best effort). */
  down(db: Db): Promise<void>;
}

export interface MigrationRecord {
  _id: string;          // filename stem
  appliedAt: Date;
  description: string;
}
