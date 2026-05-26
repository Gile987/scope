// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { RestError } from "@azure/storage-blob";
import { z } from "zod";
import type { RunState } from "@scope/core";
import type { Response } from "express";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";
import { createBlobServiceClient, extractBlobName } from "./blob-helpers.js";

async function handleToolCalls(
  ctx: RouteContext,
  res: Response,
  targetRun: RunState,
  id: string,
  iterationParam: string | undefined,
): Promise<void> {
  if (!iterationParam) {
    res.status(400).json({ error: "iteration query parameter is required" });
    return;
  }
  const iterNum = parseInt(iterationParam, 10);
  if (isNaN(iterNum) || iterNum < 1) {
    res.status(400).json({ error: "Invalid iteration number" });
    return;
  }
  const turns = targetRun.turns;
  const turn = turns?.find((t) => t.iteration === iterNum);
  const toolCallsUrl = turn?.toolCallsUrl;
  const label = `${id}-iteration-${iterNum}-tool-calls`;

  if (!toolCallsUrl) {
    res.status(404).json({ error: "No tool-calls JSONL available for this iteration" });
    return;
  }

  const blobServiceClient = createBlobServiceClient(ctx);

  const blobName = extractBlobName(toolCallsUrl);
  if (!blobName) {
    res.status(500).json({ error: "Invalid tool-calls URL format" });
    return;
  }
  const decodedBlobName = decodeURIComponent(blobName);
  const containerClient = blobServiceClient.getContainerClient("snapshots");
  const blobClient = containerClient.getBlobClient(decodedBlobName);

  const downloadResponse = await blobClient.download();
  if (!downloadResponse.readableStreamBody) {
    res.status(500).json({ error: "Failed to download tool-calls JSONL" });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Content-Disposition", `attachment; filename="${label}.jsonl"`);
  if (downloadResponse.contentLength) {
    res.setHeader("Content-Length", downloadResponse.contentLength);
  }

  downloadResponse.readableStreamBody.pipe(res);
}

export function registerRequestsToolCallsRoutes(ctx: RouteContext): void {

// Request-level tool-calls download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/tool-calls",
  tags: ["Requests"],
  summary: "Download per-iteration tool-calls JSONL",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "JSONL stream — one ToolCall per line",
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

      await handleToolCalls(ctx, res, resource.run!, id, iterationParam);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Tool-calls JSONL not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

// Per-run tool-calls download
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/runs/:runId/tool-calls",
  tags: ["Requests"],
  summary: "Download per-iteration tool-calls JSONL for a specific attempt",
  params: z.object({ id: z.string(), runId: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "JSONL stream — one ToolCall per line",
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

      await handleToolCalls(ctx, res, resolved.run, id, iterationParam);
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Tool-calls JSONL not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    }
  },
});

}
