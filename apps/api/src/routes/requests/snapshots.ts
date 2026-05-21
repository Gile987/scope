// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z } from "zod";
import type { RunState } from "shared";
import type { Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";
import { createBlobServiceClient, extractBlobName } from "./blob-helpers.js";

async function handleSnapshot(
  ctx: RouteContext,
  res: Response,
  targetRun: RunState,
  id: string,
  iteration: string,
): Promise<void> {
  const iterNum = parseInt(iteration, 10);
  if (isNaN(iterNum) || iterNum < 1) {
    res.status(400).json({ error: "Invalid iteration number" });
    return;
  }

  const turns = targetRun.turns;
  const turn = turns?.find((t: { iteration: number }) => t.iteration === iterNum);
  if (!turn?.snapshotUrl) {
    res.status(404).json({ error: `No snapshot for iteration ${iterNum}` });
    return;
  }

  const blobServiceClient = createBlobServiceClient(ctx);

  const blobName = extractBlobName(turn.snapshotUrl);
  if (!blobName) {
    res.status(500).json({ error: "Invalid snapshot URL format" });
    return;
  }
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const blobClient = containerClient.getBlockBlobClient(blobName);

  const downloadResponse = await blobClient.download();
  if (!downloadResponse.readableStreamBody) {
    res.status(500).json({ error: "Failed to download snapshot" });
    return;
  }

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${id}-iteration-${iterNum}.tar.gz"`);
  if (downloadResponse.contentLength) {
    res.setHeader("Content-Length", downloadResponse.contentLength);
  }

  downloadResponse.readableStreamBody.pipe(res);
}

export function registerRequestsSnapshotsRoutes(ctx: RouteContext): void {

// Request-level snapshot download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/snapshots/:iteration",
  tags: ["Requests"],
  summary: "Download iteration snapshot",
  params: z.object({ id: z.string(), iteration: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped snapshot archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id, iteration } = req.params;
      const iterNum = parseInt(iteration, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }

      const resource = await ctx.requestCollection.findOne({ _id: id });
      if (!resource) {
        res.status(404).json({ error: "Request not found" });
        return;
      }

      await handleSnapshot(ctx, res, resource.run!, id, iteration);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

// Per-run snapshot download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/snapshots/:iteration",
  tags: ["Requests"],
  summary: "Download iteration snapshot for a specific attempt",
  params: z.object({ id: z.string(), runId: z.string(), iteration: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped snapshot archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id, runId, iteration } = req.params;
      const iterNum = parseInt(iteration, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }

      const resolved = await resolveRunForRequest(ctx, id, runId);
      if ("error" in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await handleSnapshot(ctx, res, resolved.run, id, iteration);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

}
