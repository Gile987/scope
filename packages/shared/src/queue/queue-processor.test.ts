// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { CodingAgentQueueProcessor } from "./queue-processor.js";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "../types/types.js";
import type { VisibilityHeartbeat } from "./visibility-heartbeat.js";

const testConfig: QueueProcessorConfig = {
  mongoUri: "mongodb://localhost:27017",
  mongoDatabase: "test-db",
  mongoCollection: "test-collection",
  storageAccountName: "devstoreaccount1",
  storageConnectionString:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=key;QueueEndpoint=http://localhost:10001/devstoreaccount1;",
  queueName: "test-queue",
  batchSize: 1,
  pollIntervalMs: 50,
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: "",
};

const stubProcessor: WorkerProcessor = {
  workerName: "test-worker",
  async processMessage(): Promise<WorkerResult> {
    return { response: "ok" };
  },
  getAgentVersion() {
    return "test-1.0.0";
  },
};

describe("CodingAgentQueueProcessor.getVersionFields", () => {
  it("includes os info with platform, release, and arch", () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.os).toEqual({
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    });
  });

  it("includes workerVersion when agentVersion is available", () => {
    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.workerVersion).toMatch(/^test-1\.0\.0-/);
  });

  it("omits workerVersion when agentVersion is not available", () => {
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    const qp = new CodingAgentQueueProcessor(testConfig, noVersionProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.workerVersion).toBeUndefined();
    expect(fields.os).toBeDefined();
  });

  it("always captures os even without agentVersion", () => {
    const noVersionProcessor: WorkerProcessor = {
      workerName: "test-worker",
      async processMessage(): Promise<WorkerResult> {
        return { response: "ok" };
      },
    };
    const qp = new CodingAgentQueueProcessor(testConfig, noVersionProcessor);
    const fields = (qp as any).getVersionFields();

    expect(fields.os.platform).toBe(os.platform());
    expect(fields.os.release).toBe(os.release());
    expect(fields.os.arch).toBe(os.arch());
  });
});

// ─── Redelivery fail-fast (handleRequest pre-checks) ─────────────────────────
describe("CodingAgentQueueProcessor.handleRequest redelivery handling", () => {
  function makeHarness(runStatus: string) {
    const requestId = "req-1";
    const runId = "run-1";
    const requestDoc = {
      _id: requestId,
      workerType: "coder-acp-copilot",
      scenario: { criteria: [], task: "x" },
      run: { _id: runId, status: runStatus, attemptNumber: 1 },
    } as any;

    const findOneAndUpdate = vi.fn().mockResolvedValue(requestDoc);
    const collection = { findOneAndUpdate } as any;

    const safeDeleteMessage = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn().mockResolvedValue(undefined);

    const heartbeat: VisibilityHeartbeat = {
      stop: () => "pop-1",
      get popReceipt() { return "pop-1"; },
    };
    const message = { messageId: "msg-1", popReceipt: "pop-1", messageText: "" } as any;

    const qp = new CodingAgentQueueProcessor(testConfig, stubProcessor);
    (qp as any).collection = collection;
    (qp as any).safeDeleteMessage = safeDeleteMessage;
    // Guard: if the redelivery branch ever falls through, processMultiTurn
    // would be invoked. Stub it so any accidental call is observable.
    (qp as any).processMultiTurn = vi.fn().mockResolvedValue(undefined);

    return { qp, requestDoc, message, heartbeat, log, findOneAndUpdate, safeDeleteMessage, runId, requestId };
  }

  it("marks run failed and deletes message when run.status is 'processing' (redelivery)", async () => {
    const h = makeHarness("processing");

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = h.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: h.requestId,
      "run._id": h.runId,
      "run.status": "processing",
    });
    expect(update.$set["run.status"]).toBe("done");
    expect(update.$set["run.outcome"]).toBe("failed");
    expect(update.$set["run.error"]).toMatch(/redelivered/);
    expect(update.$set["run.finishedAt"]).toBeInstanceOf(Date);

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect(h.log).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/marked failed/),
      expect.objectContaining({ final: true, runId: h.runId }),
    );
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
  });

  it("still deletes message when atomic claim does not match (concurrent retry won)", async () => {
    const h = makeHarness("processing");
    h.findOneAndUpdate.mockResolvedValueOnce(null);

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.safeDeleteMessage).toHaveBeenCalledWith("msg-1", "pop-1");
    expect((h.qp as any).processMultiTurn).not.toHaveBeenCalled();
    // No "final" error log when claim didn't match — the run was already
    // taken over by something else.
    const finalCalls = h.log.mock.calls.filter((c: any[]) => c[2]?.final);
    expect(finalCalls).toHaveLength(0);
  });

  it("does NOT mark failed when run.status is 'queued' (proceeds to processMultiTurn)", async () => {
    const h = makeHarness("queued");

    await (h.qp as any).handleRequest(h.requestDoc, h.message, h.heartbeat, h.log, { runId: h.runId });

    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.safeDeleteMessage).not.toHaveBeenCalled();
    expect((h.qp as any).processMultiTurn).toHaveBeenCalledTimes(1);
  });
});
