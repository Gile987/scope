// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type { RouteContext } from "../../route-context.js";
import { downloadBlobToResponse } from "./blob-helpers.js";
import { registerArtifactRoutes } from "./artifact-route.js";

export function registerRequestsAtifRoutes(ctx: RouteContext): void {
  registerArtifactRoutes(ctx, {
    path: "atif",
    summary: "Download ATIF trajectory file for a specific iteration",
    perRunSummary: "Download ATIF trajectory file for a specific attempt and iteration",
    responseDescription: "ATIF v1.7 trajectory JSON file",
    errorResponses: { 400: { description: "Missing or invalid iteration" }, 404: { description: "Not found" } },
    query: z.object({ iteration: z.string().describe("The iteration number (1-based)") }),
    blobNotFoundMessage: "ATIF file not found — the blob may have been deleted or is no longer available",
    handler: async (ctx, req, res, targetRun, id) => {
      const iterationParam = req.query.iteration as string | undefined;
      if (!iterationParam) {
        res.status(400).json({ error: "Missing required query parameter: iteration" });
        return;
      }

      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }

      const turn = targetRun.turns?.find((t: { iteration: number }) => t.iteration === iterNum);
      if (!turn?.atifUrl) {
        res.status(404).json({ error: "No ATIF trajectory available" });
        return;
      }

      await downloadBlobToResponse(ctx, res, turn.atifUrl, {
        contentType: "application/json",
        filename: `${id}-iteration-${iterNum}.atif.trajectory.json`,
        label: "ATIF",
      });
    },
  });
}

