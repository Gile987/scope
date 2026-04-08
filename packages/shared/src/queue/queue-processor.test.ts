// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import os from "node:os";
import { CodingAgentQueueProcessor } from "./queue-processor.js";
import type { QueueProcessorConfig, WorkerProcessor, WorkerResult } from "../types/types.js";

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
