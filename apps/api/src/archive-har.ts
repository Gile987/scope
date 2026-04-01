// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for bundling HAR and raw chat export files in run archives.
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
 * Deep-clone a run resource and rewrite `harUrl` and `rawChatUrl` fields to relative archive paths.
 *
 * - Top-level `harUrl`     → `"run.har"`
 * - Per-turn `harUrl`      → `"iteration-{N}.har"`
 * - Top-level `rawChatUrl` → `"run.chat-export.json"`
 * - Per-turn `rawChatUrl`  → `"iteration-{N}.chat-export.json"`
 */
export function rewriteHarUrlsForArchive<T extends {
  harUrl?: string;
  rawChatUrl?: string;
  turns?: Array<{ iteration: number; harUrl?: string; rawChatUrl?: string; [key: string]: unknown }>;
}>(resource: T): T {
  const copy = JSON.parse(JSON.stringify(resource));
  if (copy.harUrl) {
    copy.harUrl = "run.har";
  }
  if (copy.rawChatUrl) {
    copy.rawChatUrl = "run.chat-export.json";
  }
  if (copy.turns) {
    for (const turn of copy.turns) {
      if (turn.harUrl) {
        turn.harUrl = `iteration-${turn.iteration}.har`;
      }
      if (turn.rawChatUrl) {
        turn.rawChatUrl = `iteration-${turn.iteration}.chat-export.json`;
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

/** Describes a raw chat export file found in an extracted archive directory. */
export interface DetectedChatFile {
  fileName: string;
  /** Iteration number (for per-turn files), or `null` for top-level `run.chat-export.json`. */
  iteration: number | null;
}

/**
 * Scan a list of filenames and return the chat export files that follow the bundled naming convention:
 * - `iteration-{N}.chat-export.json` → per-turn chat export
 * - `run.chat-export.json`           → top-level chat export
 */
export function detectBundledChatFiles(fileNames: string[]): DetectedChatFile[] {
  const results: DetectedChatFile[] = [];
  for (const name of fileNames) {
    if (!name.endsWith(".chat-export.json")) continue;
    const iterMatch = name.match(/^iteration-(\d+)\.chat-export\.json$/);
    if (iterMatch) {
      results.push({ fileName: name, iteration: parseInt(iterMatch[1], 10) });
    } else if (name === "run.chat-export.json") {
      results.push({ fileName: name, iteration: null });
    }
  }
  return results;
}

/**
 * Upload detected chat export files from an extracted archive directory to blob storage.
 * Mutates `turns` and returns the top-level `rawChatUrl` (if any).
 */
export async function uploadBundledChatFiles(opts: {
  chatFiles: DetectedChatFile[];
  runDir: string;
  runId: string;
  turns: Array<{ iteration: number; rawChatUrl?: string; [key: string]: unknown }>;
  containerClient: BlobUploader;
}): Promise<string | undefined> {
  const { chatFiles, runDir, runId, turns, containerClient } = opts;
  const { join } = await import("node:path");
  let topLevelChatUrl: string | undefined;

  for (const chat of chatFiles) {
    const chatPath = join(runDir, chat.fileName);

    if (chat.iteration !== null) {
      const blobName = `${runId}/iteration-${chat.iteration}/chat-export.json`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(chatPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId, iteration: String(chat.iteration) },
      });
      const turn = turns.find(t => t.iteration === chat.iteration);
      if (turn) {
        turn.rawChatUrl = blockBlobClient.url;
      }
    } else {
      const blobName = `${runId}/chat-export.json`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(chatPath, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        tags: { requestId: runId },
      });
      topLevelChatUrl = blockBlobClient.url;
    }
  }

  return topLevelChatUrl;
}
