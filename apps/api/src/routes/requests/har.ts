// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RouteContext } from "../../route-context.js";
import { downloadBlobToResponse } from "./blob-helpers.js";
import { registerArtifactRoutes } from "./artifact-route.js";

export function registerRequestsHarRoutes(ctx: RouteContext): void {
  registerArtifactRoutes(ctx, {
    path: "har",
    summary: "Download HAR file",
    perRunSummary: "Download HAR file for a specific attempt",
    responseDescription: "HAR-format JSON file",
    blobNotFoundMessage: "HAR file not found — the blob may have been deleted or is no longer available",
    handler: async (ctx, req, res, targetRun, id) => {
      const iterationParam = req.query.iteration as string | undefined;
      let harUrl: string | undefined;
      let label: string;

      if (iterationParam) {
        const iterNum = parseInt(iterationParam, 10);
        if (isNaN(iterNum) || iterNum < 1) {
          res.status(400).json({ error: "Invalid iteration number" });
          return;
        }
        const turn = targetRun.turns?.find((t: { iteration: number }) => t.iteration === iterNum);
        harUrl = turn?.harUrl;
        label = `${id}-iteration-${iterNum}`;
      } else {
        const turns = targetRun.turns;
        harUrl = targetRun.harUrl || turns?.[turns.length - 1]?.harUrl;
        label = id;
      }

      if (!harUrl) {
        res.status(404).json({ error: "No HAR capture available" });
        return;
      }

      await downloadBlobToResponse(ctx, res, harUrl, {
        contentType: "application/json",
        filename: `${label}.har`,
        label: "HAR",
      });
    },
  });
}
