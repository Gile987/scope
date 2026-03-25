// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for bundling HAR files in run archives.
 *
 * Extracted from the archive download/upload endpoints so the logic
 * is independently testable without Express, MongoDB, or blob-storage mocks.
 */

/**
 * Extract the blob name from an Azure Blob Storage URL whose container is "snapshots".
 * Works with both production URLs and Azurite (local emulator) URLs.
 *
 * @returns The blob name (path after `/snapshots/`), or `null` if the URL doesn't match.
 */
export function blobNameFromSnapshotsUrl(url: string): string | null {
  const parsed = new URL(url);
  const prefix = "/snapshots/";
  const idx = parsed.pathname.indexOf(prefix);
  return idx === -1 ? null : parsed.pathname.substring(idx + prefix.length);
}

/**
 * Deep-clone a run resource and rewrite `harUrl` fields to relative archive paths.
 *
 * - Top-level `harUrl` → `"run.har"`
 * - Per-turn `harUrl`  → `"iteration-{N}.har"`
 */
export function rewriteHarUrlsForArchive<T extends {
  harUrl?: string;
  turns?: Array<{ iteration: number; harUrl?: string; [key: string]: unknown }>;
}>(resource: T): T {
  const copy = JSON.parse(JSON.stringify(resource));
  if (copy.harUrl) {
    copy.harUrl = "run.har";
  }
  if (copy.turns) {
    for (const turn of copy.turns) {
      if (turn.harUrl) {
        turn.harUrl = `iteration-${turn.iteration}.har`;
      }
    }
  }
  return copy;
}

/** Describes a HAR file found in an extracted archive directory. */
export interface DetectedHarFile {
  fileName: string;
  /** Iteration number (for per-turn files), or `null` for top-level `run.har`. */
  iteration: number | null;
}

/**
 * Scan a list of filenames and return the HAR files that follow the bundled naming convention:
 * - `iteration-{N}.har` → per-turn HAR
 * - `run.har`           → top-level HAR
 *
 * Other `.har` files are ignored.
 */
export function detectBundledHarFiles(fileNames: string[]): DetectedHarFile[] {
  const results: DetectedHarFile[] = [];
  for (const name of fileNames) {
    if (!name.endsWith(".har")) continue;
    const iterMatch = name.match(/^iteration-(\d+)\.har$/);
    if (iterMatch) {
      results.push({ fileName: name, iteration: parseInt(iterMatch[1], 10) });
    } else if (name === "run.har") {
      results.push({ fileName: name, iteration: null });
    }
  }
  return results;
}

/** Minimal interface matching the blob-upload methods we need from @azure/storage-blob. */
export interface BlobUploader {
  getBlockBlobClient(blobName: string): {
    url: string;
    uploadFile(filePath: string, options?: { blobHTTPHeaders?: { blobContentType?: string }; tags?: Record<string, string> }): Promise<unknown>;
  };
}

/**
 * Upload detected HAR files from an extracted archive directory to blob storage.
 * Mutates `turns` and returns the top-level `harUrl` (if any).
 */
export async function uploadBundledHarFiles(opts: {
  harFiles: DetectedHarFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; harUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<string | undefined> {
  const { harFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");
  let topLevelHarUrl: string | undefined;

  for (const har of harFiles) {
    const harPath = join(runDir, har.fileName);

    if (har.iteration !== null) {
      // Per-turn HAR: iteration-N.har
      const blobName = `${runId}/iteration-${har.iteration}/capture.har`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(harPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId, iteration: String(har.iteration) },
      });
      const turn = turns.find(t => t.iteration === har.iteration);
      if (turn) {
        turn.harUrl = blockBlobClient.url;
      }
    } else {
      // Top-level HAR (one-shot runs): run.har
      const blobName = `${runId}/capture.har`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(harPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId },
      });
      topLevelHarUrl = blockBlobClient.url;
    }
  }

  return topLevelHarUrl;
}
