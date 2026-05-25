// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { Response } from "express";
import type { RouteContext } from "../../route-context.js";

/** Build a BlobServiceClient from the RouteContext storage configuration. */
export function createBlobServiceClient(ctx: RouteContext): BlobServiceClient {
  if (ctx.storageConnectionString) {
    return BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
  }
  return new BlobServiceClient(
    `https://${ctx.storageAccountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

/**
 * Extract the blob name from an artifact URL stored in the DB.
 * Returns the path portion after the container prefix (e.g. `/snapshots/`).
 */
export function extractBlobName(
  artifactUrl: string,
  containerPrefix = "/snapshots/",
): string | null {
  const parsed = new URL(artifactUrl);
  const idx = parsed.pathname.indexOf(containerPrefix);
  if (idx === -1) return null;
  return parsed.pathname.substring(idx + containerPrefix.length);
}

export interface DownloadBlobOptions {
  contentType: string;
  filename: string;
  label: string;
}

/**
 * Download a blob artifact by its storage URL and pipe it to the HTTP response.
 * Handles blob-name extraction, Content-Type/Disposition headers, and streaming.
 */
export async function downloadBlobToResponse(
  ctx: RouteContext,
  res: Response,
  artifactUrl: string,
  options: DownloadBlobOptions,
): Promise<void> {
  const blobServiceClient = createBlobServiceClient(ctx);

  const blobName = extractBlobName(artifactUrl);
  if (!blobName) {
    res.status(500).json({ error: `Invalid ${options.label} URL format` });
    return;
  }
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const blobClient = containerClient.getBlockBlobClient(blobName);

  const downloadResponse = await blobClient.download();
  if (!downloadResponse.readableStreamBody) {
    res.status(500).json({ error: `Failed to download ${options.label}` });
    return;
  }

  res.setHeader("Content-Type", options.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${options.filename}"`);
  if (downloadResponse.contentLength) {
    res.setHeader("Content-Length", downloadResponse.contentLength);
  }

  downloadResponse.readableStreamBody.pipe(res);
}
