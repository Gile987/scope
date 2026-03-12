// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerResult } from "../types/types.js";

// Mock BlobStorage
const mockUploadFile = vi.fn();
vi.mock("../storage/blob-storage.js", () => ({
  BlobStorage: vi.fn().mockImplementation(() => ({
    uploadFile: mockUploadFile,
    uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot"),
  })),
}));

// Mock HAR sanitizer
vi.mock("../har/har-parser.js", () => ({
  sanitizeHarFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock JudgeClient
vi.mock("./judge-client.js", () => ({
  JudgeClient: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "All good" }),
  })),
}));

// Import after mocks
const { runMultiTurnLoop } = await import("./multi-turn-loop.js");

describe("runMultiTurnLoop — video upload", () => {
  const mockProcessor = {
    workerName: "test-worker",
    processMessage: vi.fn(),
  };

  const mockLog = vi.fn().mockResolvedValue(undefined);
  const mockOnTurnComplete = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadFile.mockReset();
  });

  it("uploads video files and includes videoUrls in turn when worker returns videoFilePaths", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
      videoFilePaths: ["/tmp/video-0.webm", "/tmp/video-1.webm"],
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn()
      .mockResolvedValueOnce("https://blob/snapshots/req1/iteration-1/video-0.webm")
      .mockResolvedValueOnce("https://blob/snapshots/req1/iteration-1/video-1.webm");

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    expect(result.passed).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].videoUrls).toEqual([
      "https://blob/snapshots/req1/iteration-1/video-0.webm",
      "https://blob/snapshots/req1/iteration-1/video-1.webm",
    ]);
    // Verify upload was called with correct blob names and content type
    expect(mockBlobUploadFile).toHaveBeenCalledWith("/tmp/video-0.webm", "req1/iteration-1/video-0.webm", "video/webm");
    expect(mockBlobUploadFile).toHaveBeenCalledWith("/tmp/video-1.webm", "req1/iteration-1/video-1.webm", "video/webm");
  });

  it("does not include videoUrls when worker returns no videoFilePaths", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn();

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    expect(result.turns[0].videoUrls).toBeUndefined();
  });

  it("logs warning but continues when video upload fails", async () => {
    mockProcessor.processMessage.mockResolvedValue({
      response: "done",
      videoFilePaths: ["/tmp/video-0.webm"],
    } satisfies WorkerResult);

    const mockBlobUploadFile = vi.fn().mockRejectedValueOnce(new Error("upload failed"));

    const result = await runMultiTurnLoop({
      processor: mockProcessor as any,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 1,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: mockBlobUploadFile, uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      log: mockLog,
      onTurnComplete: mockOnTurnComplete,
    });

    // Should still complete the turn despite video upload failure
    expect(result.passed).toBe(true);
    expect(mockLog).toHaveBeenCalledWith("warn", expect.stringContaining("Failed to upload video"), expect.anything());
  });
});

describe("runMultiTurnLoop — lifecycle hooks", () => {
  const mockLog = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeConfig(processor: any, overrides: Record<string, unknown> = {}) {
    return {
      processor,
      task: "Do something",
      criteria: ["check"],
      maxIterations: 3,
      workspacePath: "/workspace",
      judgeClient: { evaluate: vi.fn().mockResolvedValue({ passed: true, feedback: "OK" }) } as any,
      blobStorage: { uploadFile: vi.fn().mockResolvedValue("https://blob/video"), uploadWorkspaceSnapshot: vi.fn().mockResolvedValue("https://blob/snapshot") } as any,
      requestId: "req1",
      log: mockLog,
      ...overrides,
    };
  }

  it("calls setup before first processMessage and teardown after", async () => {
    const callOrder: string[] = [];
    const processor = {
      workerName: "test-worker",
      setup: vi.fn(async () => { callOrder.push("setup"); }),
      teardown: vi.fn(async () => { callOrder.push("teardown"); }),
      processMessage: vi.fn(async () => { callOrder.push("processMessage"); return { response: "done" }; }),
    };

    await runMultiTurnLoop(makeConfig(processor));

    expect(processor.setup).toHaveBeenCalledTimes(1);
    expect(processor.teardown).toHaveBeenCalledTimes(1);
    expect(processor.processMessage).toHaveBeenCalled();
    expect(callOrder[0]).toBe("setup");
    expect(callOrder[callOrder.length - 1]).toBe("teardown");
  });

  it("calls teardown even when processMessage throws", async () => {
    const processor = {
      workerName: "test-worker",
      setup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      processMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const result = await runMultiTurnLoop(makeConfig(processor));

    // Multi-turn loop catches processMessage errors and returns a failed result
    expect(result.passed).toBe(false);
    expect(processor.teardown).toHaveBeenCalledTimes(1);
  });

  it("works without setup/teardown (backward compatible)", async () => {
    const processor = {
      workerName: "test-worker",
      processMessage: vi.fn(async () => ({ response: "done" })),
    };

    const result = await runMultiTurnLoop(makeConfig(processor));

    expect(result.passed).toBe(true);
    expect(processor.processMessage).toHaveBeenCalled();
  });

  it("calls setup once even with multiple iterations", async () => {
    let iteration = 0;
    const processor = {
      workerName: "test-worker",
      setup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      processMessage: vi.fn(async () => {
        iteration++;
        return { response: `iteration ${iteration}` };
      }),
    };

    // Judge fails first 2, passes on 3rd
    let judgeCallCount = 0;
    const judgeClient = {
      evaluate: vi.fn(async () => {
        judgeCallCount++;
        return { passed: judgeCallCount >= 3, feedback: judgeCallCount < 3 ? "Try again" : "OK" };
      }),
    };

    const result = await runMultiTurnLoop(makeConfig(processor, { judgeClient }));

    expect(result.passed).toBe(true);
    expect(result.turns).toHaveLength(3);
    expect(processor.setup).toHaveBeenCalledTimes(1);
    expect(processor.teardown).toHaveBeenCalledTimes(1);
    expect(processor.processMessage).toHaveBeenCalledTimes(3);
  });
});
