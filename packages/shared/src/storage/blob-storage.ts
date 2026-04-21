// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, createReadStream, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { extract } from "tar";
import type { LogEvent } from "../types/types.js";

const SNAPSHOTS_CONTAINER = "snapshots";
const LOGS_CONTAINER = "logs";
// Note: Azure Append Blobs cap at 50,000 blocks (1 block per appendBlock call).
// At ~1 log event/second a run would need 14+ hours to approach this limit,
// so the current per-event write is fine for typical benchmark run durations.

// Directories/patterns to exclude from workspace snapshots
const EXCLUDE_PATTERNS = [
  ".git",
  "node_modules",
  "dist",
  ".vscode",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "*.pyc",
];

export interface BlobStorageConfig {
  storageAccountName: string;
  storageConnectionString?: string; // For local Azurite
}

export class BlobStorage {
  private containerClient: ContainerClient;
  private logsContainerClient: ContainerClient;
  private blobServiceClient: BlobServiceClient;
  private logsContainerReady: Promise<void> | null = null;
  /** Tracks per-blob createIfNotExists — keyed by blobName, value is the settled promise. */
  private initializedBlobs = new Map<string, Promise<void>>();

  constructor(config: BlobStorageConfig) {
    let blobServiceClient: BlobServiceClient;

    if (config.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(
        config.storageConnectionString
      );
    } else {
      const credential = new DefaultAzureCredential();
      blobServiceClient = new BlobServiceClient(
        `https://${config.storageAccountName}.blob.core.windows.net`,
        credential
      );
    }

    this.blobServiceClient = blobServiceClient;
    this.containerClient = blobServiceClient.getContainerClient(SNAPSHOTS_CONTAINER);
    this.logsContainerClient = blobServiceClient.getContainerClient(LOGS_CONTAINER);
  }

  /**
   * Ensures the snapshots container exists (idempotent).
   */
  async ensureContainer(): Promise<void> {
    await this.containerClient.createIfNotExists();
  }

  /**
   * Ensures the logs container exists. Lazily initialized — the HTTP call is made
   * at most once per BlobStorage instance, regardless of concurrent callers.
   */
  private ensureLogsContainer(): Promise<void> {
    this.logsContainerReady ??= this.logsContainerClient
      .createIfNotExists()
      .then(() => undefined);
    return this.logsContainerReady;
  }

  /**
   * Appends a single log event as a JSON line to the run's append blob.
   * Creates the blob and container on first use. Blob-level initialization is
   * cached per blobName so concurrent appends only call createIfNotExists once.
   *
   * Path scheme: `{requestId}/runs/{runId}/run.jsonl`. Each retry attempt writes
   * to its own blob keyed on the run id.
   */
  async appendLogEvent(requestId: string, runId: string, logEvent: LogEvent): Promise<void> {
    await this.ensureLogsContainer();
    const blobName = `${requestId}/runs/${runId}/run.jsonl`;
    const appendBlobClient = this.logsContainerClient.getAppendBlobClient(blobName);
    if (!this.initializedBlobs.has(blobName)) {
      this.initializedBlobs.set(
        blobName,
        appendBlobClient.createIfNotExists().then(() => undefined),
      );
    }
    await this.initializedBlobs.get(blobName);
    const line = JSON.stringify(logEvent) + "\n";
    await appendBlobClient.appendBlock(line, Buffer.byteLength(line));
  }

  /**
   * Downloads all persisted log events for a run.
   *
   * Preferred: pass `logsBlobName` (the blob name stored on the RunState
   * document, e.g. `{requestId}/runs/{runId}/run.jsonl`).
   *
   * Legacy fallback (for runs created before `logsBlobName` was recorded):
   * pass `requestId` + optional `runId`. Tries the per-attempt path first,
   * then the legacy `{requestId}/run.jsonl` path on 404.
   *
   * Returns an empty array if no log blob exists at any location.
   */
  async getLogEvents(logsBlobNameOrRequestId: string, runId?: string): Promise<LogEvent[]> {
    await this.ensureLogsContainer();

    const tryDownload = async (blobName: string): Promise<LogEvent[] | undefined> => {
      const client = this.logsContainerClient.getAppendBlobClient(blobName);
      try {
        const download = await client.download();
        if (!download.readableStreamBody) return [];
        const chunks: Buffer[] = [];
        for await (const chunk of download.readableStreamBody as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString("utf-8");
        return text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as LogEvent);
      } catch (err: any) {
        if (err?.statusCode === 404) return undefined;
        throw err;
      }
    };

    // When the blob name looks like a pre-computed path (contains "/"),
    // use it directly. This is the primary path for new runs where
    // `logsBlobName` is stored on the RunState document.
    if (logsBlobNameOrRequestId.includes("/")) {
      const fromDirect = await tryDownload(logsBlobNameOrRequestId);
      return fromDirect ?? [];
    }

    // Legacy: caller passed a requestId (+ optional runId). Try the
    // per-attempt path first, then the old flat layout.
    const requestId = logsBlobNameOrRequestId;
    if (runId) {
      const fromNew = await tryDownload(`${requestId}/runs/${runId}/run.jsonl`);
      if (fromNew !== undefined) return fromNew;
    }
    const fromLegacy = await tryDownload(`${requestId}/run.jsonl`);
    return fromLegacy ?? [];
  }

  /**
   * Uploads a workspace directory as a tar.gz snapshot to blob storage.
   * Path: `{requestId}/runs/{runId}/iteration-{iteration}/workspace.tar.gz`.
   * Returns the blob URL.
   */
  async uploadWorkspaceSnapshot(
    workspacePath: string,
    requestId: string,
    runId: string,
    iteration: number
  ): Promise<string> {
    await this.ensureContainer();

    const blobName = `${requestId}/runs/${runId}/iteration-${iteration}/workspace.tar.gz`;
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    // Create tar.gz in a temp directory
    const tempDir = mkdtempSync(join(tmpdir(), "snapshot-"));
    const archivePath = join(tempDir, "workspace.tar.gz");

    try {
      // Build tar exclude flags
      const excludeFlags = EXCLUDE_PATTERNS.map((p) => `--exclude='${p}'`).join(" ");

      // Create tar.gz archive
      execSync(
        `tar czf "${archivePath}" ${excludeFlags} -C "${workspacePath}" .`,
        { stdio: "pipe" }
      );

      // Upload to blob storage
      await blockBlobClient.uploadFile(archivePath, {
        blobHTTPHeaders: {
          blobContentType: "application/gzip",
        },
        tags: {
          requestId,
          runId,
          iteration: String(iteration),
        },
      });

      return blockBlobClient.url;
    } finally {
      // Cleanup temp directory
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Uploads a workspace directory as a tar.gz snapshot to blob storage.
   * Similar to uploadWorkspaceSnapshot but takes a directory containing extracted workspace files.
   * Used when importing run archives.
   * Returns the blob URL.
   */
  async uploadSnapshotFromDirectory(
    directoryPath: string,
    requestId: string,
    iteration: number
  ): Promise<string> {
    await this.ensureContainer();

    const blobName = `${requestId}/iteration-${iteration}/workspace.tar.gz`;
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    // Create tar.gz in a temp directory
    const tempDir = mkdtempSync(join(tmpdir(), "snapshot-upload-"));
    const archivePath = join(tempDir, "workspace.tar.gz");

    try {
      // Build tar exclude flags (same patterns as uploadWorkspaceSnapshot)
      const excludeFlags = EXCLUDE_PATTERNS.map((p) => `--exclude='${p}'`).join(" ");

      // Create tar.gz archive from the directory contents
      execSync(
        `tar czf "${archivePath}" ${excludeFlags} -C "${directoryPath}" .`,
        { stdio: "pipe" }
      );

      // Upload to blob storage
      await blockBlobClient.uploadFile(archivePath, {
        blobHTTPHeaders: {
          blobContentType: "application/gzip",
        },
        tags: {
          requestId,
          iteration: String(iteration),
        },
      });

      return blockBlobClient.url;
    } finally {
      // Cleanup temp directory
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Uploads a single file (e.g. HAR capture) to blob storage.
   * Returns the blob URL.
   */
  async uploadFile(
    filePath: string,
    blobName: string,
    contentType: string = "application/json"
  ): Promise<string> {
    await this.ensureContainer();

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(filePath, {
      blobHTTPHeaders: {
        blobContentType: contentType,
      },
    });

    return blockBlobClient.url;
  }

  /**
   * Downloads a snapshot from blob storage and extracts it to the target directory.
   */
  async downloadAndExtractSnapshot(
    snapshotUrl: string,
    targetDir: string
  ): Promise<void> {
    // Parse blob name from URL — handles both Azure and Azurite URL formats:
    //   Azure:   https://<account>.blob.core.windows.net/snapshots/<blobName>
    //   Azurite: http://azurite:10000/<account>/snapshots/<blobName>
    const url = new URL(snapshotUrl);
    const containerPrefix = `/${SNAPSHOTS_CONTAINER}/`;
    const containerIndex = url.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      throw new Error(
        `Snapshot URL does not contain container '${SNAPSHOTS_CONTAINER}': ${snapshotUrl}`
      );
    }
    const blobName = url.pathname.substring(
      containerIndex + containerPrefix.length
    );
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    // Download to temp file
    const tempDir = mkdtempSync(join(tmpdir(), "snapshot-dl-"));
    const archivePath = join(tempDir, "workspace.tar.gz");

    try {
      await blockBlobClient.downloadToFile(archivePath);

      // Extract tar.gz to target directory
      execSync(`mkdir -p "${targetDir}" && tar xzf "${archivePath}" -C "${targetDir}"`, {
        stdio: "pipe",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
