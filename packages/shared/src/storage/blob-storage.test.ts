// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Mock @azure/storage-blob ──────────────────────────────────────────────

const mockAppendBlobClient = {
  createIfNotExists: vi.fn().mockResolvedValue(undefined),
  appendBlock: vi.fn().mockResolvedValue(undefined),
  download: vi.fn(),
};

const mockLogsContainerClient = {
  createIfNotExists: vi.fn().mockResolvedValue(undefined),
  getAppendBlobClient: vi.fn(() => mockAppendBlobClient),
};

const mockSnapshotsContainerClient = {
  createIfNotExists: vi.fn().mockResolvedValue(undefined),
};

const mockBlobServiceClient = {
  getContainerClient: vi.fn((name: string) =>
    name === "logs" ? mockLogsContainerClient : mockSnapshotsContainerClient,
  ),
};

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: vi.fn(() => mockBlobServiceClient),
  },
  ContainerClient: vi.fn(),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

const { BlobStorage } = await import("./blob-storage.js");

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeStorage() {
  return new BlobStorage({
    storageAccountName: "test",
    storageConnectionString: "UseDevelopmentStorage=true",
  });
}

function makeLogEvent(msg: string): LogEvent {
  return { timestamp: "2026-01-01T00:00:00Z", level: "info", message: msg };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("BlobStorage — log helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("appendLogEvent", () => {
    it("creates the container and blob, then appends a JSON line", async () => {
      const storage = makeStorage();
      const event = makeLogEvent("hello");

      await storage.appendLogEvent("run-123", event);

      expect(mockLogsContainerClient.createIfNotExists).toHaveBeenCalledOnce();
      expect(mockLogsContainerClient.getAppendBlobClient).toHaveBeenCalledWith("run-123/run.jsonl");
      expect(mockAppendBlobClient.createIfNotExists).toHaveBeenCalledOnce();

      const [data, length] = mockAppendBlobClient.appendBlock.mock.calls[0];
      expect(data).toContain('"hello"');
      expect(data.endsWith("\n")).toBe(true);
      expect(length).toBe(Buffer.byteLength(data));
    });

    it("only calls container createIfNotExists once across multiple appends", async () => {
      const storage = makeStorage();

      await storage.appendLogEvent("run-123", makeLogEvent("first"));
      await storage.appendLogEvent("run-123", makeLogEvent("second"));
      await storage.appendLogEvent("run-123", makeLogEvent("third"));

      expect(mockLogsContainerClient.createIfNotExists).toHaveBeenCalledOnce();
    });

    it("only calls container createIfNotExists once for concurrent appends", async () => {
      const storage = makeStorage();

      await Promise.all([
        storage.appendLogEvent("run-123", makeLogEvent("a")),
        storage.appendLogEvent("run-123", makeLogEvent("b")),
        storage.appendLogEvent("run-123", makeLogEvent("c")),
      ]);

      expect(mockLogsContainerClient.createIfNotExists).toHaveBeenCalledOnce();
    });
  });

  describe("getLogEvents", () => {
    it("downloads and parses JSONL lines", async () => {
      const events = [makeLogEvent("first"), makeLogEvent("second")];
      const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";

      const readable = (async function* () {
        yield Buffer.from(jsonl);
      })();
      mockAppendBlobClient.download.mockResolvedValue({ readableStreamBody: readable });

      const storage = makeStorage();
      const result = await storage.getLogEvents("run-123");

      expect(result).toHaveLength(2);
      expect(result[0].message).toBe("first");
      expect(result[1].message).toBe("second");
    });

    it("returns empty array when blob does not exist (404)", async () => {
      const err = Object.assign(new Error("BlobNotFound"), { statusCode: 404 });
      mockAppendBlobClient.download.mockRejectedValue(err);

      const storage = makeStorage();
      const result = await storage.getLogEvents("run-new");

      expect(result).toEqual([]);
    });

    it("re-throws non-404 errors", async () => {
      const err = Object.assign(new Error("ServerError"), { statusCode: 500 });
      mockAppendBlobClient.download.mockRejectedValue(err);

      const storage = makeStorage();
      await expect(storage.getLogEvents("run-bad")).rejects.toThrow("ServerError");
    });

    it("returns empty array when readableStreamBody is null", async () => {
      mockAppendBlobClient.download.mockResolvedValue({ readableStreamBody: null });

      const storage = makeStorage();
      const result = await storage.getLogEvents("run-empty");

      expect(result).toEqual([]);
    });

    it("skips blank lines in JSONL", async () => {
      const event = makeLogEvent("only");
      const jsonl = "\n" + JSON.stringify(event) + "\n\n";

      const readable = (async function* () {
        yield Buffer.from(jsonl);
      })();
      mockAppendBlobClient.download.mockResolvedValue({ readableStreamBody: readable });

      const storage = makeStorage();
      const result = await storage.getLogEvents("run-123");

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("only");
    });
  });
});
