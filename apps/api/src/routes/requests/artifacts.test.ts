// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for blob-proxied artifact endpoints:
 *   - GET /api/v1/requests/:id/har
 *   - GET /api/v1/requests/:id/tool-calls
 *   - GET /api/v1/requests/:id/snapshots/:iteration
 *   - GET /api/v1/requests/:id/video
 *
 * These endpoints all follow the same pattern:
 *   1. Find the request document
 *   2. Resolve a blob URL from the run/turn
 *   3. Connect to Azure Blob Storage and proxy the download
 *
 * We mock:
 *   - MongoDB via test-helpers (findOne on requestCollection)
 *   - @azure/storage-blob (BlobServiceClient.fromConnectionString → download)
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { Readable } from "stream";
import { app, _injectTestDependencies } from "../../index.js";
import { createAllMockDependencies } from "../../test-helpers.js";

// ─── Module stubs (must come before app import resolves) ────────────────────

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001", "002"],
    pending: [],
  }),
}));

// Set a fake storage connection string BEFORE module loading so the endpoints
// use BlobServiceClient.fromConnectionString (which we mock) instead of
// DefaultAzureCredential (which would fail in tests).
vi.hoisted(() => {
  process.env.STORAGE_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=mockaccount;AccountKey=bW9jaw==;EndpointSuffix=core.windows.net";
});

vi.mock("../../llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../../prompt-feature-llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../../task-prompt-llm.js", () => ({ isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false) }));

// ─── Azure Blob Storage mock ───────────────────────────────────────────────

const { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient } = vi.hoisted(() => {
  const mockDownload = vi.fn();
  const mockGetProperties = vi.fn();
  const mockGetBlockBlobClient = vi.fn().mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  const mockGetBlobClient = vi.fn().mockReturnValue({
    download: mockDownload,
    getProperties: mockGetProperties,
  });
  const mockGetContainerClient = vi.fn().mockReturnValue({
    getBlockBlobClient: mockGetBlockBlobClient,
    getBlobClient: mockGetBlobClient,
  });
  return { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient };
});

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const original = await importOriginal<typeof import("@azure/storage-blob")>();
  return {
    ...original,
    BlobServiceClient: {
      fromConnectionString: vi.fn().mockReturnValue({
        getContainerClient: mockGetContainerClient,
      }),
    },
  };
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create a Readable stream from a string (simulates blob download body). */
function readableFrom(content: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(content)]);
}

/** Raw supertest response parser — avoids JSON parsing for binary/stream responses. */
function rawParser(res: any, cb: (err: Error | null, body: string) => void): void {
  let data = "";
  res.on("data", (chunk: Buffer) => (data += chunk.toString()));
  res.on("end", () => cb(null, data));
}

/** Standard blob URL in the format the endpoints expect. */
function blobUrl(path: string): string {
  return `https://mockaccount.blob.core.windows.net/snapshots/${path}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Blob-proxied artifact endpoints", () => {
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);

    // Re-wire blob mock chain after clearAllMocks
    mockGetBlockBlobClient.mockReturnValue({
      download: mockDownload,
      getProperties: mockGetProperties,
    });
    mockGetBlobClient.mockReturnValue({
      download: mockDownload,
      getProperties: mockGetProperties,
    });
    mockGetContainerClient.mockReturnValue({
      getBlockBlobClient: mockGetBlockBlobClient,
      getBlobClient: mockGetBlobClient,
    });

    // Default: blob download returns a readable body
    mockDownload.mockResolvedValue({
      readableStreamBody: readableFrom("mock-blob-content"),
      contentLength: 17,
    });
    mockGetProperties.mockResolvedValue({ contentLength: 17 });
  });

  // =========================================================================
  // GET /api/v1/requests/:id/har
  // =========================================================================

  describe("GET /api/v1/requests/:id/har", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await supertest(app).get("/api/v1/requests/missing/har");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 404 when no HAR capture available", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/har");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No HAR capture available" });
    });

    it("proxies HAR download from run-level harUrl", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done", harUrl: blobUrl("req-1/run.har") },
      });

      mockDownload.mockResolvedValue({
        readableStreamBody: readableFrom('{"log":{}}'),
        contentLength: 10,
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/har").buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/json");
      expect(res.headers["content-disposition"]).toContain("req-1.har");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/run.har");
    });

    it("proxies HAR download from per-iteration turn harUrl", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [
            { iteration: 1, harUrl: blobUrl("req-1/iter-1.har") },
            { iteration: 2, harUrl: blobUrl("req-1/iter-2.har") },
          ],
        },
      });

      mockDownload.mockResolvedValue({
        readableStreamBody: readableFrom('{"log":{}}'),
        contentLength: 10,
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/har?iteration=2").buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("req-1-iteration-2.har");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-2.har");
    });

    it("returns 400 for invalid iteration number", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/har?iteration=abc");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it("falls back to last turn harUrl when no run-level harUrl", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [
            { iteration: 1, harUrl: blobUrl("req-1/iter-1.har") },
            { iteration: 2, harUrl: blobUrl("req-1/iter-2.har") },
          ],
        },
      });

      mockDownload.mockResolvedValue({
        readableStreamBody: readableFrom('{"log":{}}'),
        contentLength: 10,
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/har").buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      // Falls back to last turn
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-2.har");
    });
  });

  // =========================================================================
  // GET /api/v1/requests/:id/tool-calls
  // =========================================================================

  describe("GET /api/v1/requests/:id/tool-calls", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await supertest(app).get("/api/v1/requests/missing/tool-calls?iteration=1");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 400 when iteration query parameter is missing", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/tool-calls");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "iteration query parameter is required" });
    });

    it("returns 400 for invalid iteration number", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/tool-calls?iteration=0");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it("returns 404 when no tool-calls available for iteration", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [{ iteration: 1 }],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/tool-calls?iteration=1");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No tool-calls JSONL available for this iteration" });
    });

    it("proxies tool-calls JSONL download", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [
            { iteration: 1, toolCallsUrl: blobUrl("req-1/iter-1-tool-calls.jsonl") },
          ],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/tool-calls?iteration=1");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/x-ndjson");
      expect(res.headers["content-disposition"]).toContain("tool-calls.jsonl");
      expect(mockGetBlobClient).toHaveBeenCalledWith("req-1/iter-1-tool-calls.jsonl");
    });
  });

  // =========================================================================
  // GET /api/v1/requests/:id/snapshots/:iteration
  // =========================================================================

  describe("GET /api/v1/requests/:id/snapshots/:iteration", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await supertest(app).get("/api/v1/requests/missing/snapshots/1");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 400 for invalid iteration number", async () => {
      const res = await supertest(app).get("/api/v1/requests/req-1/snapshots/abc");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it("returns 404 when no snapshot for the iteration", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [{ iteration: 1 }],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/snapshots/1");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No snapshot for iteration 1" });
    });

    it("proxies snapshot download", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [
            { iteration: 1, snapshotUrl: blobUrl("req-1/iter-1-snapshot.tar.gz") },
          ],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/snapshots/1");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/gzip");
      expect(res.headers["content-disposition"]).toContain("req-1-iteration-1.tar.gz");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-1-snapshot.tar.gz");
    });
  });

  // =========================================================================
  // GET /api/v1/requests/:id/video
  // =========================================================================

  describe("GET /api/v1/requests/:id/video", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await supertest(app).get("/api/v1/requests/missing/video");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 404 when no video recordings available", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No video recordings available" });
    });

    it("proxies video download from run-level videoUrls", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          videoUrls: [blobUrl("req-1/video-0.webm")],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("video/webm");
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/video-0.webm");
    });

    it("proxies video from per-iteration turn", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          turns: [
            { iteration: 1, videoUrls: [blobUrl("req-1/iter-1-video-0.webm")] },
          ],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video?iteration=1");
      expect(res.status).toBe(200);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-1-video-0.webm");
    });

    it("proxies setup video", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          setupVideoUrls: [blobUrl("req-1/setup-video-0.webm")],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video?phase=setup");
      expect(res.status).toBe(200);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/setup-video-0.webm");
    });

    it("returns 404 when video index is out of range", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          videoUrls: [blobUrl("req-1/video-0.webm")],
        },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video?index=5");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Video index 5 not found");
    });

    it("returns 400 for invalid video index", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video?index=-1");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid video index" });
    });

    it("supports Range requests for video seeking", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: {
          _id: "run-1",
          status: "done",
          videoUrls: [blobUrl("req-1/video-0.webm")],
        },
      });

      mockGetProperties.mockResolvedValue({ contentLength: 1000 });

      const partialBody = "a]".repeat(250); // 500 bytes
      mockDownload.mockResolvedValue({
        readableStreamBody: readableFrom(partialBody),
        contentLength: 500,
      });

      const res = await supertest(app)
        .get("/api/v1/requests/req-1/video")
        .set("Range", "bytes=0-499")
        .buffer(true)
        .parse(rawParser);

      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe("bytes 0-499/1000");
      expect(res.headers["content-length"]).toBe("500");
      expect(mockDownload).toHaveBeenCalledWith(0, 500);
    });

    it("returns 400 for invalid iteration number", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-1", status: "done" },
      });

      const res = await supertest(app).get("/api/v1/requests/req-1/video?iteration=abc");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });
  });
});
