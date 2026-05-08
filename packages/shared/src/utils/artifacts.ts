// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import crypto from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";

const ARTIFACTS_ROOT = "/tmp/artifacts";

/**
 * Create a fresh, isolated artifacts directory for a worker run.
 *
 * Mirrors the workspace utility: cleans the parent `/tmp/artifacts/` directory
 * first so leftovers from crashed runs are always removed, then creates a new
 * `run-<rand>` subdirectory.
 *
 * Use this for per-iteration debug captures (raw chat streams, stderr dumps,
 * etc.) that should NOT live inside the agent's workspace (because the
 * workspace is tar.gz'd into the iteration snapshot).
 *
 * @returns The absolute path to the new artifacts directory (e.g. `/tmp/artifacts/run-a1b2c3d4`).
 */
export function createFreshArtifactsDir(): string {
  if (existsSync(ARTIFACTS_ROOT)) {
    rmSync(ARTIFACTS_ROOT, { recursive: true, force: true });
  }
  const suffix = crypto.randomBytes(4).toString("hex");
  const artifactsPath = path.join(ARTIFACTS_ROOT, `run-${suffix}`);
  mkdirSync(artifactsPath, { recursive: true });
  return artifactsPath;
}

/**
 * Clean up the artifacts root directory (`/tmp/artifacts/`).
 *
 * Safe to call even if the directory doesn't exist.
 */
export function cleanupArtifacts(): void {
  if (existsSync(ARTIFACTS_ROOT)) {
    rmSync(ARTIFACTS_ROOT, { recursive: true, force: true });
  }
}
