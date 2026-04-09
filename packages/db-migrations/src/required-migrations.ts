// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Canonical list of required migrations.
 *
 * The API readiness probe queries the `_migrations` collection and checks
 * that every file listed here has been applied. If any are missing the pod
 * reports "not ready" and Kubernetes will hold traffic until the migration
 * Job completes.
 *
 * **Maintenance**: add an entry here whenever you create a new migration file.
 */

export const REQUIRED_MIGRATIONS: readonly string[] = [
  "001-backfill-task-prompts.ts",
  "002-create-indexes.ts",
  "003-create-skill-indexes.ts",
  "004-add-submission-id-index.ts",
  "005-backfill-iteration-durations.ts",
  "006-split-status-outcome.ts",
  "007-rename-exhausted-to-finished.ts",
];
