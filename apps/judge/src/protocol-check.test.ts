// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK so no real Copilot CLI is spawned.
const startMock = vi.fn();
const getStatusMock = vi.fn();
const stopMock = vi.fn();
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    start = startMock;
    getStatus = getStatusMock;
    stop = stopMock;
  },
}));

const { verifyCopilotProtocol } = await import("./protocol-check.js");

describe("verifyCopilotProtocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    startMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ version: "1.0.63", protocolVersion: 3 });
    stopMock.mockResolvedValue([]);
  });

  it("resolves and stops the client when the SDK<->CLI protocol is compatible", async () => {
    await expect(verifyCopilotProtocol(1000)).resolves.toBeUndefined();
    expect(startMock).toHaveBeenCalledOnce();
    expect(getStatusMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it("propagates a protocol mismatch thrown by start() and still stops the client", async () => {
    startMock.mockRejectedValue(
      new Error("SDK protocol version mismatch: SDK expects version 2, but server reports version 3.")
    );

    await expect(verifyCopilotProtocol(1000)).rejects.toThrow(/protocol version mismatch/i);
    expect(getStatusMock).not.toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it("rejects with a timeout when the CLI does not start in time, and still stops the client", async () => {
    startMock.mockReturnValue(new Promise(() => undefined)); // never resolves

    await expect(verifyCopilotProtocol(20)).rejects.toThrow(/did not start within 20ms/i);
    expect(stopMock).toHaveBeenCalledOnce();
  });

  it("does not mask the original error if stop() rejects during cleanup", async () => {
    startMock.mockRejectedValue(new Error("boot failure"));
    stopMock.mockRejectedValue(new Error("stop failed"));

    await expect(verifyCopilotProtocol(1000)).rejects.toThrow(/boot failure/i);
  });
});
