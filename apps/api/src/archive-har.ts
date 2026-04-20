// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for bundling HAR and raw chat export files in run archives.
 *
 * Extracted from the archive download/upload endpoints so the logic
 * is independently testable without Express, MongoDB, or blob-storage mocks.
 */

import type { Pack } from "tar-stream";
import { stringify as yamlStringify } from "yaml";
import { pipeline } from "stream/promises";
import type { RestError } from "@azure/storage-blob";

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

/** Minimal interface for blob download needed by packRunIntoTar. */
export interface BlobDownloader {
  getBlockBlobClient(blobName: string): {
    download(): Promise<{
      readableStreamBody?: NodeJS.ReadableStream;
      contentLength?: number;
    }>;
  };
  getBlobClient(blobName: string): {
    download(): Promise<{
      readableStreamBody?: NodeJS.ReadableStream;
      contentLength?: number;
    }>;
  };
}

/** A run document with the fields needed for archive packing. */
export interface ArchivableRun {
  _id: string;
  harUrl?: string;
  rawChatUrl?: string;
  turns?: Array<{
    iteration: number;
    snapshotUrl?: string;
    harUrl?: string;
    rawChatUrl?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Pack a single run's artifacts into a tar-stream pack instance.
 *
 * Writes entries under `{prefix}/` (typically the run ID). This function does
 * NOT finalize the pack — the caller is responsible for calling `pack.finalize()`
 * after all runs have been packed.
 *
 * @param pack       - tar-stream pack instance (shared across runs in batch mode)
 * @param resource   - the run document
 * @param container  - blob storage container client for downloading snapshots/HARs/chats
 * @param prefix     - directory prefix inside the tar (defaults to resource._id)
 * @param isRestError - predicate to check if an error is a blob-not-found RestError
 * @param logsContainer - optional blob storage container client for downloading logs (run.jsonl)
 */
export async function packRunIntoTar(
  pack: Pack,
  resource: ArchivableRun,
  container: BlobDownloader,
  prefix?: string,
  isRestError?: (err: unknown) => boolean,
  logsContainer?: BlobDownloader,
): Promise<void> {
  const id = prefix ?? resource._id;
  const isBlobNotFound = isRestError ?? (() => false);

  // Entry 1: run.yaml — the full run document (with relative HAR paths)
  const archiveResource = rewriteHarUrlsForArchive(resource);
  const yamlContent = yamlStringify(archiveResource, { lineWidth: 120 });
  const yamlBuf = Buffer.from(yamlContent, "utf-8");
  pack.entry({ name: `${id}/run.yaml`, size: yamlBuf.length }, yamlBuf);

  // Entries 2..N: iteration snapshots as-is (.tar.gz blobs)
  for (const turn of resource.turns ?? []) {
    if (!turn.snapshotUrl) continue;
    try {
      const blobName = blobNameFromSnapshotsUrl(turn.snapshotUrl);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({
        name: `${id}/iteration-${turn.iteration}.tar.gz`,
        size: downloadResponse.contentLength,
      });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle HAR files into the archive
  const harEntries: Array<{ url: string; entryName: string }> = [];
  for (const turn of resource.turns ?? []) {
    if (turn.harUrl) harEntries.push({ url: turn.harUrl, entryName: `${id}/iteration-${turn.iteration}.har` });
  }
  if (resource.harUrl) harEntries.push({ url: resource.harUrl, entryName: `${id}/run.har` });

  for (const { url, entryName } of harEntries) {
    try {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle raw chat export files into the archive
  const chatEntries: Array<{ url: string; entryName: string }> = [];
  for (const turn of resource.turns ?? []) {
    if (turn.rawChatUrl) chatEntries.push({ url: turn.rawChatUrl, entryName: `${id}/iteration-${turn.iteration}.chat-export.json` });
  }
  if (resource.rawChatUrl) chatEntries.push({ url: resource.rawChatUrl, entryName: `${id}/run.chat-export.json` });

  for (const { url, entryName } of chatEntries) {
    try {
      const blobName = blobNameFromSnapshotsUrl(url);
      if (!blobName) continue;
      const blobClient = container.getBlockBlobClient(blobName);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;
      const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
      await pipeline(downloadResponse.readableStreamBody, entry);
    } catch (blobError) {
      if (isBlobNotFound(blobError)) continue;
      throw blobError;
    }
  }

  // Bundle log events (run.jsonl) from the logs container.
  // Logs are stored as AppendBlobs, so use getBlobClient (type-agnostic) rather
  // than getBlockBlobClient — the latter returns contentLength: undefined for
  // append blobs, causing the entry to be silently skipped.
  if (logsContainer) {
    try {
      const logBlobName = `${resource._id}/run.jsonl`;
      const blobClient = logsContainer.getBlobClient(logBlobName);
      const downloadResponse = await blobClient.download();
      if (downloadResponse.readableStreamBody && downloadResponse.contentLength) {
        const entry = pack.entry({ name: `${id}/run.jsonl`, size: downloadResponse.contentLength });
        await pipeline(downloadResponse.readableStreamBody, entry);
      }
    } catch (blobError) {
      if (!isBlobNotFound(blobError)) throw blobError;
    }
  }
}
