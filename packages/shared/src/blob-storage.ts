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

const SNAPSHOTS_CONTAINER = "snapshots";

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

    this.containerClient = blobServiceClient.getContainerClient(SNAPSHOTS_CONTAINER);
  }

  /**
   * Ensures the snapshots container exists (idempotent).
   */
  async ensureContainer(): Promise<void> {
    await this.containerClient.createIfNotExists();
  }

  /**
   * Uploads a workspace directory as a tar.gz snapshot to blob storage.
   * Returns the blob URL.
   */
  async uploadWorkspaceSnapshot(
    workspacePath: string,
    requestId: string,
    iteration: number
  ): Promise<string> {
    await this.ensureContainer();

    const blobName = `${requestId}/iteration-${iteration}/workspace.tar.gz`;
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
   * Downloads a snapshot from blob storage and extracts it to the target directory.
   */
  async downloadAndExtractSnapshot(
    snapshotUrl: string,
    targetDir: string
  ): Promise<void> {
    // Parse blob name from URL
    const url = new URL(snapshotUrl);
    const blobName = url.pathname.replace(`/${SNAPSHOTS_CONTAINER}/`, "");
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
