// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { JudgeClient, isRetryableJudgeError } from "shared";
import type { ConversationTurn, CriterionResult } from "shared";
import type { PostProcessHandler, PostProcessorMessage, HandlerContext } from "../types.js";

/** Minimal shape of the run document fields this handler reads/writes. */
interface RunDoc {
  run?: {
    _id?: string;
    observations?: string[];
    turns?: ConversationTurn[];
  };
}

/**
 * Taxonomy Handler (pp-taxonomy): records per-iteration boolean observations.
 *
 * For each iteration turn with a `snapshotUrl`, reuses the judge service to
 * evaluate the run's selected observation criteria (`run.observations`) against
 * the codebase snapshot AND the agent trajectory (ATIF) — sending `atifUrl` in
 * place of `toolCallsUrl`. Results are written to `turn.observationResults`,
 * mirroring gate `criteriaResults`. Never gates, never steers the agent.
 * Empty/absent `observations` → no-op. See issue #1156.
 */
export class TaxonomyHandler implements PostProcessHandler {
  readonly type = "taxonomy";
  private readonly judge: JudgeClient;

  constructor(judge?: JudgeClient, judgeUrl = process.env.JUDGE_URL || process.env.JUDGE_SERVICE_URL || "http://localhost:3002") {
    this.judge = judge ?? new JudgeClient(judgeUrl);
  }

  async process(message: PostProcessorMessage, ctx: HandlerContext): Promise<void> {
    const { requestId, iteration } = message;

    const doc = (await ctx.collection.findOne({ _id: requestId } as any)) as RunDoc | null;
    const observations = doc?.run?.observations ?? [];
    const turns = doc?.run?.turns ?? [];

    if (observations.length === 0) {
      await ctx.log("info", "No observations selected, skipping taxonomy evaluation");
      return;
    }
    if (turns.length === 0) {
      await ctx.log("info", "No turns found, skipping taxonomy evaluation");
      return;
    }

    const turnsToProcess = iteration ? turns.filter((t) => t.iteration === iteration) : turns;
    let processedCount = 0;

    for (const turn of turnsToProcess) {
      if (!turn.snapshotUrl) {
        await ctx.log("info", `Iteration ${turn.iteration}: no snapshot, skipping`);
        continue;
      }

      try {
        const result = await this.judge.evaluate({
          snapshotUrl: turn.snapshotUrl,
          criteria: observations,
          conversationHistory: turns,
          ...(turn.atifUrl ? { atifUrl: turn.atifUrl } : {}),
          requestId,
        });

        const observationResults: CriterionResult[] = result.criteriaResults ?? [];

        await ctx.collection.updateOne(
          { _id: requestId, "run.turns.iteration": turn.iteration } as any,
          { $set: { "run.turns.$.observationResults": observationResults } } as any,
        );

        processedCount++;
        await ctx.log("info", `Iteration ${turn.iteration}: ${observationResults.length} observations recorded`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isRetryableJudgeError(err)) {
          await ctx.log("error", `Iteration ${turn.iteration}: judge infrastructure error, failing handler: ${errMsg}`);
          throw err;
        }
        await ctx.log("warn", `Iteration ${turn.iteration}: observation evaluation failed: ${errMsg}`);
      }
    }

    await ctx.log("info", `Taxonomy evaluation complete: ${processedCount}/${turnsToProcess.length} iterations processed`);
  }
}
