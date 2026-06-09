// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { apiRoute } from "../../openapi/api-route.js";
import type { RouteContext } from "../../route-context.js";
import { resolveRunForRequest } from "./resolve-run.js";

/**
 * Re-evaluate route — allows manual judge re-run for runs that failed
 * during evaluation (e.g., due to rate limits) without re-running the agent.
 *
 * Preconditions:
 * - Run must be in terminal state (done + failed)
 * - failureReason must be judge_error or judge_rate_limited
 * - The run must have at least one turn with a snapshotUrl
 */
export function registerRequestsReEvaluateRoutes(ctx: RouteContext): void {

apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/:id/runs/:runId/re-evaluate",
  tags: ["Requests"],
  summary: "Re-run judge evaluation for a failed run without re-running the agent",
  response: z.object({
    id: z.string(),
    runId: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  handler: async (req, res) => {
    const { id, runId } = req.params;

    const resolved = await resolveRunForRequest(ctx, id, runId);
    if ("error" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    const { run, request } = resolved;

    // Validate run is in terminal failed state
    if (run.status !== "done" || run.outcome !== "failed") {
      res.status(409).json({
        error: `Run is not in a re-evaluable state. Current: status=${run.status}, outcome=${run.outcome}. Expected: done + failed.`,
      });
      return;
    }

    // Only allow re-evaluation for judge-related failures
    const allowedReasons = ["judge_error", "judge_rate_limited"];
    if (run.failureReason && !allowedReasons.includes(run.failureReason)) {
      res.status(409).json({
        error: `Run failed due to "${run.failureReason}" which is not eligible for re-evaluation. Only judge_error and judge_rate_limited failures can be re-evaluated.`,
      });
      return;
    }

    // If no failureReason set (legacy runs), check error message for judge patterns
    if (!run.failureReason) {
      const isJudgeError = run.error?.includes("Judge evaluation failed");
      if (!isJudgeError) {
        res.status(409).json({
          error: "Run does not appear to have failed during judge evaluation. Only judge failures can be re-evaluated.",
        });
        return;
      }
    }

    // Find the last turn with a snapshot URL (the point to re-evaluate from)
    const lastTurnWithSnapshot = [...(run.turns || [])].reverse().find(t => t.snapshotUrl);
    if (!lastTurnWithSnapshot) {
      res.status(409).json({
        error: "No snapshot URL found in run turns. Cannot re-evaluate without a workspace snapshot.",
      });
      return;
    }

    // Get criteria from the request's scenario
    const criteria = request.scenario?.criteria;
    if (!criteria || criteria.length === 0) {
      res.status(409).json({
        error: "No criteria found on request. Cannot re-evaluate without criteria.",
      });
      return;
    }

    // Reset run state for re-evaluation: mark as processing
    const updateResult = await ctx.requestCollection.updateOne(
      { _id: id, "run._id": runId, "run.status": "done" },
      {
        $set: {
          "run.status": "processing",
          "run.outcome": undefined,
          "run.failureReason": undefined,
          "run.error": undefined,
          "run.updatedAt": new Date(),
        },
        $unset: {
          "run.outcome": "",
          "run.failureReason": "",
          "run.error": "",
          "run.finishedAt": "",
        },
      },
    );

    if (updateResult.matchedCount === 0) {
      res.status(409).json({
        error: "Run status changed concurrently. Please retry.",
      });
      return;
    }

    // Enqueue re-evaluation message to the judge queue
    // The worker will pick this up and call the judge with the existing snapshot
    const workerType = request.workerType;
    const queueClient = ctx.queueClients.get(workerType as any);
    if (!queueClient) {
      // Revert status since we can't enqueue
      await ctx.requestCollection.updateOne(
        { _id: id, "run._id": runId },
        {
          $set: {
            "run.status": "done",
            "run.outcome": "failed",
            "run.failureReason": "judge_error",
            "run.error": "Re-evaluation failed: no queue client for worker type",
            "run.updatedAt": new Date(),
            "run.finishedAt": new Date(),
          },
        },
      );
      res.status(500).json({
        error: `No queue client available for worker type "${workerType}". Cannot enqueue re-evaluation.`,
      });
      return;
    }

    // Send re-evaluate message to worker queue
    await queueClient.sendMessage(
      Buffer.from(JSON.stringify({
        requestId: id,
        runId,
        action: "re-evaluate",
        snapshotUrl: lastTurnWithSnapshot.snapshotUrl,
        criteria,
        personaInstructions: request.personaInstructions,
      })).toString("base64"),
    );

    res.json({
      id,
      runId,
      status: "processing",
      message: "Re-evaluation queued. The judge will re-evaluate the last workspace snapshot.",
    });
  },
});

// Bulk re-evaluate — re-run judge for multiple failed runs
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-re-evaluate",
  tags: ["Requests"],
  summary: "Bulk re-run judge evaluation for multiple failed runs",
  body: z.object({
    ids: z.array(z.string()).min(1).max(100).describe("Request IDs to re-evaluate"),
  }),
  response: z.object({
    queued: z.number(),
    skipped: z.number(),
    results: z.array(z.object({
      id: z.string(),
      queued: z.boolean(),
      error: z.string().optional(),
    })),
  }),
  handler: async (req, res) => {
    const { ids } = req.body;
    const results: { id: string; queued: boolean; error?: string }[] = [];
    let queued = 0;

    for (const id of ids) {
      const doc = await ctx.requestCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!doc) {
        results.push({ id, queued: false, error: "Not found" });
        continue;
      }

      const run = doc.run;
      if (!run || run.status !== "done" || run.outcome !== "failed") {
        results.push({ id, queued: false, error: "Not in failed state" });
        continue;
      }

      const allowedReasons = ["judge_error", "judge_rate_limited"];
      const isJudgeFailure = run.failureReason
        ? allowedReasons.includes(run.failureReason)
        : run.error?.includes("Judge evaluation failed");

      if (!isJudgeFailure) {
        results.push({ id, queued: false, error: "Not a judge failure" });
        continue;
      }

      const lastTurnWithSnapshot = [...(run.turns || [])].reverse().find(t => t.snapshotUrl);
      if (!lastTurnWithSnapshot) {
        results.push({ id, queued: false, error: "No snapshot available" });
        continue;
      }

      const criteria = doc.scenario?.criteria;
      if (!criteria || criteria.length === 0) {
        results.push({ id, queued: false, error: "No criteria" });
        continue;
      }

      // Reset and enqueue
      await ctx.requestCollection.updateOne(
        { _id: id, "run._id": run._id, "run.status": "done" },
        {
          $set: { "run.status": "processing", "run.updatedAt": new Date() },
          $unset: { "run.outcome": "", "run.failureReason": "", "run.error": "", "run.finishedAt": "" },
        },
      );

      const queueClient = ctx.queueClients.get(doc.workerType as any);
      if (queueClient) {
        await queueClient.sendMessage(
          Buffer.from(JSON.stringify({
            requestId: id,
            runId: run._id,
            action: "re-evaluate",
            snapshotUrl: lastTurnWithSnapshot.snapshotUrl,
            criteria,
            personaInstructions: doc.personaInstructions,
          })).toString("base64"),
        );
        results.push({ id, queued: true });
        queued++;
      } else {
        results.push({ id, queued: false, error: "No queue client" });
      }
    }

    res.json({ queued, skipped: ids.length - queued, results });
  },
});

}
