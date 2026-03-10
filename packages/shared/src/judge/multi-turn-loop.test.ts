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
