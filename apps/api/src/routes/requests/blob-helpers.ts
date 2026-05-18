// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
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
