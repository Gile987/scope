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

async function handleAtif(
  ctx: RouteContext,
  res: Response,
  targetRun: RunState,
  id: string,
  iterationParam: string | undefined,
): Promise<void> {
  let atifUrl: string | undefined;
  let label: string;

  if (iterationParam) {
    const iterNum = parseInt(iterationParam, 10);
    if (isNaN(iterNum) || iterNum < 1) {
      res.status(400).json({ error: "Invalid iteration number" });
      return;
    }
    const turns = targetRun.turns;
    const turn = turns?.find((t: { iteration: number }) => t.iteration === iterNum);
    atifUrl = turn?.atifUrl;
    label = `${id}-iteration-${iterNum}`;
  } else {
    // Default to last iteration with an ATIF file
    const turns = targetRun.turns;
    const turnWithAtif = turns?.slice().reverse().find((t) => t.atifUrl);
    atifUrl = turnWithAtif?.atifUrl;
    label = id;
  }

  if (!atifUrl) {
    res.status(404).json({ error: "No ATIF trajectory available" });
    return;
  }

  const blobServiceClient = createBlobServiceClient(ctx);

  const blobName = extractBlobName(atifUrl);
  if (!blobName) {
    res.status(500).json({ error: "Invalid ATIF URL format" });
    return;
  }
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const blobClient = containerClient.getBlockBlobClient(blobName);

  const downloadResponse = await blobClient.download();
  if (!downloadResponse.readableStreamBody) {
    res.status(500).json({ error: "Failed to download ATIF file" });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${label}.trajectory.json"`);
  if (downloadResponse.contentLength) {
    res.setHeader("Content-Length", downloadResponse.contentLength);
  }

  downloadResponse.readableStreamBody.pipe(res);
}

export function registerRequestsAtifRoutes(ctx: RouteContext): void {

// Request-level ATIF download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/atif",
  tags: ["Requests"],
  summary: "Download ATIF trajectory file",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "ATIF v1.7 trajectory JSON file",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id } = req.params;
      const iterationParam = req.query.iteration as string | undefined;

      const resource = await ctx.requestCollection.findOne({ _id: id });
      if (!resource) {
        res.status(404).json({ error: "Request not found" });
        return;
      }

      await handleAtif(ctx, res, resource.run!, id, iterationParam);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "ATIF file not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

// Per-run ATIF download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/atif",
  tags: ["Requests"],
  summary: "Download ATIF trajectory file for a specific attempt",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "ATIF v1.7 trajectory JSON file",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
      const { id, runId } = req.params;
      const iterationParam = req.query.iteration as string | undefined;

      const resolved = await resolveRunForRequest(ctx, id, runId);
      if ("error" in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      await handleAtif(ctx, res, resolved.run, id, iterationParam);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "ATIF file not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

}
