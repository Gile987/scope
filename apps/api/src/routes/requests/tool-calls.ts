// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RouteContext } from "../../route-context.js";
import { downloadBlobToResponse } from "./blob-helpers.js";
import { registerArtifactRoutes } from "./artifact-route.js";

export function registerRequestsToolCallsRoutes(ctx: RouteContext): void {
  registerArtifactRoutes(ctx, {
    path: "tool-calls",
    summary: "Download per-iteration tool-calls JSONL",
    perRunSummary: "Download per-iteration tool-calls JSONL for a specific attempt",
    responseDescription: "JSONL stream — one ToolCall per line",
    blobNotFoundMessage: "Tool-calls JSONL not found — the blob may have been deleted or is no longer available",
    handler: async (ctx, req, res, targetRun, id) => {
      const iterationParam = req.query.iteration as string | undefined;
      if (!iterationParam) {
        res.status(400).json({ error: "iteration query parameter is required" });
        return;
      }
      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }
      const turn = targetRun.turns?.find((t) => t.iteration === iterNum);
      if (!turn?.toolCallsUrl) {
        res.status(404).json({ error: "No tool-calls JSONL available for this iteration" });
        return;
      }

      await downloadBlobToResponse(ctx, res, turn.toolCallsUrl, {
        contentType: "application/x-ndjson",
        filename: `${id}-iteration-${iterNum}-tool-calls.jsonl`,
        label: "tool-calls JSONL",
      });
    },
  });
}
