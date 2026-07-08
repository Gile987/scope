// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Codebase Seeder — downloads a codebase revision archive via the API and
 * extracts it into the workspace root, so the agent starts from the real
 * project tree instead of an empty directory.
 *
 * Runs during worker setup, BEFORE skills are extracted and BEFORE the agent
 * starts. The revision archive is normalized to a root-level tar.gz at
 * resolution time, so extraction goes straight into the workspace root with no
 * `--strip-components` handling.
 */

import { mkdirSync } from "fs";
import { CodebaseClient } from "./codebase-client.js";
import { extractArchiveBuffer } from "./codebase-archive.js";

export interface SeedCodebaseOptions {
  /** CodebaseRevisionDocument._id to seed from. */
  revisionId: string;
  /** CodebaseClient instance (pre-configured with API URL). */
  codebaseClient: CodebaseClient;
  /** Workspace root directory to seed into. */
  workspacePath: string;
  /** Optional async log function. */
  log?: (msg: string) => Promise<void> | void;
}

/**
 * Download a codebase revision archive and extract it into the workspace root.
 *
 * @returns true if the workspace was seeded, false if nothing was done.
 * @throws if the archive cannot be downloaded or extracted (seeding is a hard
 *         prerequisite — a failure here must fail the run, not silently start
 *         from an empty workspace).
 */
export async function seedCodebaseToWorkspace(options: SeedCodebaseOptions): Promise<boolean> {
  const { revisionId, codebaseClient, workspacePath, log } = options;
  if (!revisionId) return false;

  await log?.(`Seeding workspace from codebase revision ${revisionId}`);
  const config = await codebaseClient.resolveCodebase(revisionId);
  const archive = await codebaseClient.downloadCodebaseArchive(revisionId);

  mkdirSync(workspacePath, { recursive: true });
  await extractArchiveBuffer(archive, workspacePath);

  await log?.(`Seeded workspace from codebase "${config.ref}" (${config.sourceType})`);
  return true;
}
