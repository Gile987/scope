// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JudgeInfrastructureError, type JudgeClient } from "shared";
import { TaxonomyHandler } from "./taxonomy-handler.js";
import type { HandlerContext, PostProcessorMessage } from "../types.js";

function makeCtx(doc: unknown): HandlerContext & { collection: { updateOne: ReturnType<typeof vi.fn> } } {
  return {
    blobStorage: {} as any,
    collection: {
      findOne: vi.fn().mockResolvedValue(doc),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    } as any,
    log: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const msg: PostProcessorMessage = { type: "taxonomy", requestId: "req-1", runId: "run-1" };

describe("TaxonomyHandler", () => {
  let judge: { evaluate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    judge = { evaluate: vi.fn() };
  });

  it("has type 'taxonomy'", () => {
    expect(new TaxonomyHandler(judge as unknown as JudgeClient).type).toBe("taxonomy");
  });

  it("no-ops when no observations are selected", async () => {
    const ctx = makeCtx({ _id: "req-1", observations: [], run: { turns: [{ iteration: 1, snapshotUrl: "s://1" }] } });
    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(ctx.collection.updateOne).not.toHaveBeenCalled();
  });

  it("reads observations from the request top-level, not run.observations (#1156 regression)", async () => {
    // The API persists selected observation ids at the request top-level
    // (RequestDocument.observations). A doc that only carries the legacy
    // run.observations must be treated as "none selected" → no-op, proving the
    // handler reads the canonical location the submit path actually writes.
    const ctx = makeCtx({
      _id: "req-1",
      run: { observations: ["dep_removed"], turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }] },
    });
    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
    expect(judge.evaluate).not.toHaveBeenCalled();
    expect(ctx.collection.updateOne).not.toHaveBeenCalled();
  });

  it("writes judge criteriaResults to each turn's observationResults and sends atifUrl", async () => {
    judge.evaluate.mockResolvedValue({
      passed: true,
      feedback: "ok",
      criteriaResults: [{ criterionId: "dep_removed", passed: true, feedback: "left-pad removed", evaluated: true }],
    });
    const ctx = makeCtx({
      _id: "req-1",
      observations: ["dep_removed"],
      run: {
        turns: [{ iteration: 1, snapshotUrl: "s://1", atifUrl: "a://1" }],
      },
    });

    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);

    expect(judge.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotUrl: "s://1", criteria: ["dep_removed"], atifUrl: "a://1" }),
    );
    const call = judge.evaluate.mock.calls[0][0];
    expect(call.gate).toBeUndefined();
    expect(call.toolCallsUrl).toBeUndefined();
    expect(ctx.collection.updateOne).toHaveBeenCalledWith(
      { _id: "req-1", "run.turns.iteration": 1 },
      { $set: { "run.turns.$.observationResults": [{ criterionId: "dep_removed", passed: true, feedback: "left-pad removed", evaluated: true }] } },
    );
  });

  it("skips iterations without a snapshotUrl", async () => {
    judge.evaluate.mockResolvedValue({ passed: true, feedback: "", criteriaResults: [] });
    const ctx = makeCtx({ _id: "req-1", observations: ["c1"], run: { turns: [{ iteration: 1 }] } });
    await new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx);
    expect(judge.evaluate).not.toHaveBeenCalled();
  });

  it("throws on judge infrastructure error so the handler is marked failed", async () => {
    judge.evaluate.mockRejectedValue(new JudgeInfrastructureError("down", { httpStatus: 503 }));
    const ctx = makeCtx({ _id: "req-1", observations: ["c1"], run: { turns: [{ iteration: 1, snapshotUrl: "s://1" }] } });
    await expect(new TaxonomyHandler(judge as unknown as JudgeClient).process(msg, ctx)).rejects.toThrow("down");
  });
});
