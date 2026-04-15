// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types/types.js";

// ─── Mock @azure/storage-blob ─────────────────────────────────────────────────

const mockAppendBlock = vi.fn().mockResolvedValue(undefined);
const mockCreateIfNotExists = vi.fn().mockResolvedValue(undefined);
const mockDownload = vi.fn();

const mockGetAppendBlobClient = vi.fn(() => ({
  createIfNotExists: mockCreateIfNotExists,
  appendBlock: mockAppendBlock,
  download: mockDownload,
}));

const mockGetContainerClientForLogs = vi.fn(() => ({
  createIfNotExists: mockCreateIfNotExists,
  getAppendBlobClient: mockGetAppendBlobClient,
}));

const mockGetContainerClientForSnapshots = vi.fn(() => ({
  createIfNotExists: mockCreateIfNotExists,
  getBlockBlobClient: vi.fn(),
}));

vi.mock("@azure/storage-blob", () => {
  const mockGetContainerClient = vi.fn((name: string) => {
    if (name === "logs") return mockGetContainerClientForLogs();
    return mockGetContainerClientForSnapshots();
  });

  return {
    BlobServiceClient: {
      fromConnectionString: vi.fn(() => ({
        getContainerClient: mockGetContainerClient,
      })),
    },
    ContainerClient: vi.fn(),
    StorageSharedKeyCredential: vi.fn(),
  };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("fs", () => ({
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}));
vi.mock("tar", () => ({ extract: vi.fn() }));

import { BlobStorage } from "./blob-storage.js";

const config = { storageAccountName: "test", storageConnectionString: "UseDevelopmentStorage=true" };

const makeEvent = (msg: string): LogEvent => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  level: "info",
  source: "coder",
  message: msg,
});

describe("BlobStorage.appendLogEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the blob and appends a JSONL line", async () => {
    const storage = new BlobStorage(config);
    const event = makeEvent("hello");

    await storage.appendLogEvent("req-1", event);

    expect(mockCreateIfNotExists).toHaveBeenCalledTimes(2); // container + blob
    expect(mockAppendBlock).toHaveBeenCalledOnce();
    const [data, length] = mockAppendBlock.mock.calls[0];
    const line = data.toString("utf-8");
    expect(line).toBe(JSON.stringify(event) + "\n");
    expect(length).toBe(Buffer.byteLength(line, "utf-8"));
  });

  it("uses requestId as blob name (requestId.jsonl)", async () => {
    const storage = new BlobStorage(config);
    await storage.appendLogEvent("my-run-id", makeEvent("test"));

    expect(mockGetAppendBlobClient).toHaveBeenCalledWith("my-run-id.jsonl");
  });
});

describe("BlobStorage.getLogEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when blob does not exist (404)", async () => {
    mockDownload.mockRejectedValueOnce({ statusCode: 404 });
    const storage = new BlobStorage(config);
    const events = await storage.getLogEvents("missing-run");

    expect(events).toEqual([]);
  });

  it("rethrows non-404 errors", async () => {
    mockDownload.mockRejectedValueOnce({ statusCode: 500, message: "server error" });
    const storage = new BlobStorage(config);

    await expect(storage.getLogEvents("bad-run")).rejects.toMatchObject({ statusCode: 500 });
  });

  it("returns parsed log events from JSONL blob", async () => {
    const events = [makeEvent("first"), makeEvent("second")];
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const buffer = Buffer.from(jsonl);

    mockDownload.mockResolvedValueOnce({
      readableStreamBody: (async function* () { yield buffer; })(),
    });

    const storage = new BlobStorage(config);
    const result = await storage.getLogEvents("req-1");

    expect(result).toEqual(events);
  });

  it("handles trailing newlines without producing empty entries", async () => {
    const event = makeEvent("only one");
    const jsonl = JSON.stringify(event) + "\n\n";
    mockDownload.mockResolvedValueOnce({
      readableStreamBody: (async function* () { yield Buffer.from(jsonl); })(),
    });

    const storage = new BlobStorage(config);
    const result = await storage.getLogEvents("req-2");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(event);
  });

  it("returns events in the order they were appended", async () => {
    const events = [makeEvent("a"), makeEvent("b"), makeEvent("c")];
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    mockDownload.mockResolvedValueOnce({
      readableStreamBody: (async function* () { yield Buffer.from(jsonl); })(),
    });

    const storage = new BlobStorage(config);
    const result = await storage.getLogEvents("req-3");

    expect(result.map((e) => e.message)).toEqual(["a", "b", "c"]);
  });
});
