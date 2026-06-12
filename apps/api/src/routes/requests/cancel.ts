// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";

/**
 * Atomically marks a request as done/failed and signals the worker to exit.
 */
async function cancelRequest(
  ctx: Pick<RouteContext, "requestCollection" | "heartbeatStore">,
  id: string,
): Promise<{ success: boolean; previousStatus?: string; error?: string }> {
  const doc = await ctx.requestCollection.findOne({ _id: id, deletedAt: { $exists: false } });
  if (!doc) return { success: false, error: "Not found" };

  const currentStatus = doc.run?.status;
  if (currentStatus === "done") {
    return { success: false, previousStatus: currentStatus, error: `Cannot cancel request in terminal status "done".` };
  }
  if (currentStatus === "paused") {
    return { success: false, previousStatus: currentStatus, error: `Cannot cancel a paused request. Resume it first or delete it.` };
  }

  const result = await ctx.requestCollection.updateOne(
    {
      _id: id,
      "run.status": { $in: ["pending", "queued", "processing"] },
      deletedAt: { $exists: false },
    },
    {
      $set: {
        "run.status": "done",
        "run.outcome": "failed",
        "run.error": "Run cancelled by user",
        "run.finishedAt": new Date(),
        "run.updatedAt": new Date(),
        updatedAt: new Date(),
      },
    },
  );
  if (result.matchedCount === 0) {
    return { success: false, previousStatus: currentStatus, error: "Status changed concurrently" };
  }

  if (currentStatus === "processing" && doc.run?._id) {
    await ctx.heartbeatStore.setCancelled(doc.run._id);
    await ctx.heartbeatStore.delete(doc.run._id);
  }
  return { success: true, previousStatus: currentStatus };
}

export function registerRequestsCancelRoutes(ctx: RouteContext): void {

// Cancel a single request (any non-terminal status)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/cancel",
  tags: ["Requests"],
  summary: "Cancel a request (marks as done/failed and signals worker to exit)",
  response: z.object({
    id: z.string(),
    previousStatus: z.string(),
    status: z.string(),
    outcome: z.string(),
  }),
  handler: async (req, res) => {
    const { id } = req.params;
    const result = await cancelRequest(ctx, id);
    if (!result.success) {
      const status = result.error === "Not found" ? 404 : 409;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ id, previousStatus: result.previousStatus!, status: "done", outcome: "failed" });
  },
});

// Bulk cancel
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-cancel",
  tags: ["Requests"],
  summary: "Cancel multiple requests",
  body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
  response: z.object({
    cancelled: z.number(),
    skipped: z.number(),
    results: z.array(z.object({
      id: z.string(),
      cancelled: z.boolean(),
      previousStatus: z.string().optional(),
      error: z.string().optional(),
    })),
  }),
  handler: async (req, res) => {
    const { ids } = req.body;
    const results: { id: string; cancelled: boolean; previousStatus?: string; error?: string }[] = [];
    let cancelled = 0;
    for (const id of ids) {
      const result = await cancelRequest(ctx, id);
      if (result.success) {
        results.push({ id, cancelled: true, previousStatus: result.previousStatus });
        cancelled++;
      } else {
        results.push({ id, cancelled: false, previousStatus: result.previousStatus, error: result.error });
      }
    }
    res.json({ cancelled, skipped: ids.length - cancelled, results });
  },
});

}
