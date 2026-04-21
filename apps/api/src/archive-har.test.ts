// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import {
  blobNameFromSnapshotsUrl,
  rewriteHarUrlsForArchive,
  detectBundledHarFiles,
  uploadBundledHarFiles,
  detectBundledChatFiles,
  uploadBundledChatFiles,
  packRunIntoTar,
  type BlobUploader,
  type BlobDownloader,
  type ArchivableRun,
} from "./archive-har.js";

// --- rewriteHarUrlsForArchive ---

describe("rewriteHarUrlsForArchive", () => {
  it("rewrites run.harUrl to run.har", () => {
    const resource = {
      run: {
        harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/capture.har",
        turns: [],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.harUrl).toBe("run.har");
  });

  it("rewrites per-turn harUrl to iteration-N.har", () => {
    const resource = {
      run: {
        turns: [
          { iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-1/capture.har" },
          { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
        ],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.turns![0].harUrl).toBe("iteration-1.har");
    expect(result.run!.turns![1].harUrl).toBe("iteration-2.har");
  });

  it("leaves turns without harUrl unchanged", () => {
    const resource = {
      run: {
        turns: [
          { iteration: 1, snapshotUrl: "https://example.com/snap", harUrl: undefined as string | undefined },
          { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
        ],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.turns![0].harUrl).toBeUndefined();
    expect(result.run!.turns![1].harUrl).toBe("iteration-2.har");
  });

  it("handles resource with no harUrl at all", () => {
    const resource = {
      run: {
        turns: [{ iteration: 1 }],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.harUrl).toBeUndefined();
    expect(result.run!.turns![0].harUrl).toBeUndefined();
  });

  it("does not mutate the original resource", () => {
    const resource = {
      run: {
        harUrl: "https://storage.blob.core.windows.net/snapshots/abc/capture.har",
        turns: [{ iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har" }],
      },
    };
    rewriteHarUrlsForArchive(resource);
    expect(resource.run.harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/capture.har");
    expect(resource.run.turns[0].harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har");
  });
});

// --- blobNameFromSnapshotsUrl ---

describe("blobNameFromSnapshotsUrl", () => {
  it("extracts blob name from Azure Blob Storage URL", () => {
    const url = "https://mystorageaccount.blob.core.windows.net/snapshots/abc123/iteration-1/capture.har";
    expect(blobNameFromSnapshotsUrl(url)).toBe("abc123/iteration-1/capture.har");
  });

  it("extracts blob name from Azurite URL", () => {
    const url = "http://127.0.0.1:10000/devstoreaccount1/snapshots/abc123/capture.har";
    expect(blobNameFromSnapshotsUrl(url)).toBe("abc123/capture.har");
  });

  it("returns null when URL has no snapshots container", () => {
    const url = "https://mystorageaccount.blob.core.windows.net/other-container/abc123/file.har";
    expect(blobNameFromSnapshotsUrl(url)).toBeNull();
  });
});

// --- detectBundledHarFiles ---

describe("detectBundledHarFiles", () => {
  it("detects per-turn HAR files", () => {
    const files = ["iteration-1.har", "iteration-2.har", "iteration-1.tar.gz", "run.yaml"];
    const result = detectBundledHarFiles(files);
    expect(result).toEqual([
      { fileName: "iteration-1.har", iteration: 1 },
      { fileName: "iteration-2.har", iteration: 2 },
    ]);
  });

  it("detects top-level run.har", () => {
    const files = ["run.yaml", "run.har", "iteration-1.tar.gz"];
    const result = detectBundledHarFiles(files);
    expect(result).toEqual([{ fileName: "run.har", iteration: null }]);
  });

  it("detects both per-turn and top-level HAR files", () => {
    const files = ["run.yaml", "run.har", "iteration-1.har", "iteration-2.har", "iteration-1.tar.gz"];
    const result = detectBundledHarFiles(files);
    expect(result).toHaveLength(3);
    expect(result.find(h => h.iteration === null)?.fileName).toBe("run.har");
    expect(result.filter(h => h.iteration !== null)).toHaveLength(2);
  });

  it("returns empty when no HAR files present", () => {
    const files = ["run.yaml", "iteration-1.tar.gz", "iteration-2.tar.gz"];
    expect(detectBundledHarFiles(files)).toEqual([]);
  });

  it("ignores HAR files with unexpected names", () => {
    const files = ["random.har", "other-file.har", "run.yaml"];
    expect(detectBundledHarFiles(files)).toEqual([]);
  });
});

// --- uploadBundledHarFiles ---

describe("uploadBundledHarFiles", () => {
  function makeMockContainerClient() {
    const uploaded: Array<{ blobName: string; filePath: string; contentType: string; tags: Record<string, string> }> = [];
    const client: BlobUploader = {
      getBlockBlobClient(blobName: string) {
        return {
          url: `https://mock.blob.core.windows.net/snapshots/${blobName}`,
          async uploadFile(filePath: string, options?: { blobHTTPHeaders?: { blobContentType?: string }; tags?: Record<string, string> }) {
            uploaded.push({
              blobName,
              filePath,
              contentType: options?.blobHTTPHeaders?.blobContentType ?? "",
              tags: options?.tags ?? {},
            });
          },
        };
      },
    };
    return { client, uploaded };
  }

  it("uploads per-turn HAR files and sets harUrl on matching turns", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const turns: Array<{ iteration: number; harUrl?: string }> = [
      { iteration: 1 },
      { iteration: 2 },
    ];

    const topLevelUrl = await uploadBundledHarFiles({
      harFiles: [
        { fileName: "iteration-1.har", iteration: 1 },
        { fileName: "iteration-2.har", iteration: 2 },
      ],
      runDir: "/tmp/extracted/run123",
      runId: "run123",
      turns,
      containerClient: client,
    });

    expect(topLevelUrl).toBeUndefined();
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0].blobName).toBe("run123/iteration-1/capture.har");
    expect(uploaded[1].blobName).toBe("run123/iteration-2/capture.har");
    expect(turns[0].harUrl).toBe("https://mock.blob.core.windows.net/snapshots/run123/iteration-1/capture.har");
    expect(turns[1].harUrl).toBe("https://mock.blob.core.windows.net/snapshots/run123/iteration-2/capture.har");
  });

  it("uploads top-level run.har and returns its URL", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const turns: Array<{ iteration: number; harUrl?: string }> = [];

    const topLevelUrl = await uploadBundledHarFiles({
      harFiles: [{ fileName: "run.har", iteration: null }],
      runDir: "/tmp/extracted/run456",
      runId: "run456",
      turns,
      containerClient: client,
    });

    expect(topLevelUrl).toBe("https://mock.blob.core.windows.net/snapshots/run456/capture.har");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].blobName).toBe("run456/capture.har");
    expect(uploaded[0].contentType).toBe("application/json");
  });

  it("handles both per-turn and top-level HAR files together", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const turns: Array<{ iteration: number; harUrl?: string }> = [{ iteration: 1 }];

    const topLevelUrl = await uploadBundledHarFiles({
      harFiles: [
        { fileName: "iteration-1.har", iteration: 1 },
        { fileName: "run.har", iteration: null },
      ],
      runDir: "/tmp/extracted/run789",
      runId: "run789",
      turns,
      containerClient: client,
    });

    expect(uploaded).toHaveLength(2);
    expect(topLevelUrl).toBeDefined();
    expect(turns[0].harUrl).toBeDefined();
  });

  it("does nothing when no HAR files are provided", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const topLevelUrl = await uploadBundledHarFiles({
      harFiles: [],
      runDir: "/tmp/extracted/run000",
      runId: "run000",
      turns: [],
      containerClient: client,
    });

    expect(topLevelUrl).toBeUndefined();
    expect(uploaded).toHaveLength(0);
  });
});

// --- rewriteHarUrlsForArchive: rawChatUrl ---

describe("rewriteHarUrlsForArchive — rawChatUrl", () => {
  it("rewrites run.rawChatUrl to run.chat-export.json", () => {
    const resource = {
      run: {
        rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc123/chat-export.json",
        turns: [],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.rawChatUrl).toBe("run.chat-export.json");
  });

  it("rewrites per-turn rawChatUrl to iteration-N.chat-export.json", () => {
    const resource = {
      run: {
        turns: [
          { iteration: 1, rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-1/chat-export.json" },
          { iteration: 2, rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/chat-export.json" },
        ],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.turns![0].rawChatUrl).toBe("iteration-1.chat-export.json");
    expect(result.run!.turns![1].rawChatUrl).toBe("iteration-2.chat-export.json");
  });

  it("rewrites both harUrl and rawChatUrl together", () => {
    const resource = {
      run: {
        harUrl: "https://storage.blob.core.windows.net/snapshots/abc/capture.har",
        rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc/chat-export.json",
        turns: [
          {
            iteration: 1,
            harUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har",
            rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/chat-export.json",
          },
        ],
      },
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.run!.harUrl).toBe("run.har");
    expect(result.run!.rawChatUrl).toBe("run.chat-export.json");
    expect(result.run!.turns![0].harUrl).toBe("iteration-1.har");
    expect(result.run!.turns![0].rawChatUrl).toBe("iteration-1.chat-export.json");
  });

  it("does not mutate the original resource rawChatUrl", () => {
    const resource = {
      run: {
        rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc/chat-export.json",
        turns: [{ iteration: 1, rawChatUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/chat-export.json" }],
      },
    };
    rewriteHarUrlsForArchive(resource);
    expect(resource.run.rawChatUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/chat-export.json");
    expect(resource.run.turns[0].rawChatUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/iter-1/chat-export.json");
  });
});

// --- detectBundledChatFiles ---

describe("detectBundledChatFiles", () => {
  it("detects per-turn chat export files", () => {
    const files = ["iteration-1.chat-export.json", "iteration-2.chat-export.json", "run.yaml"];
    const result = detectBundledChatFiles(files);
    expect(result).toEqual([
      { fileName: "iteration-1.chat-export.json", iteration: 1 },
      { fileName: "iteration-2.chat-export.json", iteration: 2 },
    ]);
  });

  it("detects top-level run.chat-export.json", () => {
    const files = ["run.yaml", "run.chat-export.json", "iteration-1.tar.gz"];
    const result = detectBundledChatFiles(files);
    expect(result).toEqual([{ fileName: "run.chat-export.json", iteration: null }]);
  });

  it("detects both per-turn and top-level chat files", () => {
    const files = ["run.chat-export.json", "iteration-1.chat-export.json", "iteration-2.chat-export.json"];
    const result = detectBundledChatFiles(files);
    expect(result).toHaveLength(3);
    expect(result.find(c => c.iteration === null)?.fileName).toBe("run.chat-export.json");
    expect(result.filter(c => c.iteration !== null)).toHaveLength(2);
  });

  it("returns empty when no chat files present", () => {
    const files = ["run.yaml", "iteration-1.tar.gz", "iteration-1.har"];
    expect(detectBundledChatFiles(files)).toEqual([]);
  });

  it("ignores chat-export files with unexpected names", () => {
    const files = ["random.chat-export.json", "other.json", "run.yaml"];
    expect(detectBundledChatFiles(files)).toEqual([]);
  });
});

// --- uploadBundledChatFiles ---

describe("uploadBundledChatFiles", () => {
  function makeMockContainerClient() {
    const uploaded: Array<{ blobName: string; filePath: string; contentType: string; tags: Record<string, string> }> = [];
    const client: BlobUploader = {
      getBlockBlobClient(blobName: string) {
        return {
          url: `https://mock.blob.core.windows.net/snapshots/${blobName}`,
          async uploadFile(filePath: string, options?: { blobHTTPHeaders?: { blobContentType?: string }; tags?: Record<string, string> }) {
            uploaded.push({
              blobName,
              filePath,
              contentType: options?.blobHTTPHeaders?.blobContentType ?? "",
              tags: options?.tags ?? {},
            });
          },
        };
      },
    };
    return { client, uploaded };
  }

  it("uploads per-turn chat files and sets rawChatUrl on matching turns", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const turns: Array<{ iteration: number; rawChatUrl?: string }> = [
      { iteration: 1 },
      { iteration: 2 },
    ];

    const topLevelUrl = await uploadBundledChatFiles({
      chatFiles: [
        { fileName: "iteration-1.chat-export.json", iteration: 1 },
        { fileName: "iteration-2.chat-export.json", iteration: 2 },
      ],
      runDir: "/tmp/extracted/run123",
      runId: "run123",
      turns,
      containerClient: client,
    });

    expect(topLevelUrl).toBeUndefined();
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0].blobName).toBe("run123/iteration-1/chat-export.json");
    expect(uploaded[1].blobName).toBe("run123/iteration-2/chat-export.json");
    expect(turns[0].rawChatUrl).toBe("https://mock.blob.core.windows.net/snapshots/run123/iteration-1/chat-export.json");
    expect(turns[1].rawChatUrl).toBe("https://mock.blob.core.windows.net/snapshots/run123/iteration-2/chat-export.json");
  });

  it("uploads top-level run.chat-export.json and returns its URL", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const turns: Array<{ iteration: number; rawChatUrl?: string }> = [];

    const topLevelUrl = await uploadBundledChatFiles({
      chatFiles: [{ fileName: "run.chat-export.json", iteration: null }],
      runDir: "/tmp/extracted/run456",
      runId: "run456",
      turns,
      containerClient: client,
    });

    expect(topLevelUrl).toBe("https://mock.blob.core.windows.net/snapshots/run456/chat-export.json");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].blobName).toBe("run456/chat-export.json");
    expect(uploaded[0].contentType).toBe("application/json");
  });

  it("does nothing when no chat files are provided", async () => {
    const { client, uploaded } = makeMockContainerClient();
    const topLevelUrl = await uploadBundledChatFiles({
      chatFiles: [],
      runDir: "/tmp/extracted/run000",
      runId: "run000",
      turns: [],
      containerClient: client,
    });

    expect(topLevelUrl).toBeUndefined();
    expect(uploaded).toHaveLength(0);
  });
});

// --- packRunIntoTar ---

describe("packRunIntoTar", () => {
  function makeMockBlobContainer(blobs: Record<string, { body: Buffer; length: number }> = {}): BlobDownloader {
    return {
      getBlockBlobClient(blobName: string) {
        return {
          async download() {
            const blob = blobs[blobName];
            if (!blob) throw Object.assign(new Error("Not found"), { statusCode: 404, code: "BlobNotFound" });
            const { Readable } = await import("stream");
            return {
              readableStreamBody: Readable.from(blob.body),
              contentLength: blob.length,
            };
          },
        };
      },
    };
  }

  function collectPackEntries(pack: import("tar-stream").Pack): Promise<Array<{ name: string; size: number; data: Buffer }>> {
    return new Promise((resolve, reject) => {
      const { extract } = require("tar-stream");
      const ex = extract();
      const entries: Array<{ name: string; size: number; data: Buffer }> = [];
      ex.on("entry", (header: any, stream: any, next: any) => {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          entries.push({ name: header.name, size: header.size, data: Buffer.concat(chunks) });
          next();
        });
      });
      ex.on("finish", () => resolve(entries));
      ex.on("error", reject);
      pack.pipe(ex);
    });
  }

  it("packs run.yaml with rewritten URLs", async () => {
    const { pack } = await import("tar-stream");
    const p = pack();
    const container = makeMockBlobContainer();

    const run: ArchivableRun = {
      _id: "run-001",
      run: {
        harUrl: "https://storage.blob.core.windows.net/snapshots/run-001/capture.har",
        turns: [],
      },
    };

    const entriesPromise = collectPackEntries(p);
    await packRunIntoTar(p, run, container, "run-001", () => true);
    p.finalize();

    const entries = await entriesPromise;
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("run-001/run.yaml");
    // The YAML should have rewritten harUrl
    const content = entries[0].data.toString();
    expect(content).toContain("run.har");
    expect(content).not.toContain("blob.core.windows.net");
  });

  it("includes iteration snapshots from blob storage", async () => {
    const { pack } = await import("tar-stream");
    const p = pack();
    const snapshotData = Buffer.from("fake-snapshot-data");
    const container = makeMockBlobContainer({
      "run-002/iteration-1/workspace.tar.gz": { body: snapshotData, length: snapshotData.length },
    });

    const run: ArchivableRun = {
      _id: "run-002",
      run: {
        turns: [
          { iteration: 1, snapshotUrl: "https://storage.blob.core.windows.net/snapshots/run-002/iteration-1/workspace.tar.gz" },
        ],
      },
    };

    const entriesPromise = collectPackEntries(p);
    await packRunIntoTar(p, run, container, "run-002", () => true);
    p.finalize();

    const entries = await entriesPromise;
    const names = entries.map(e => e.name);
    expect(names).toContain("run-002/run.yaml");
    expect(names).toContain("run-002/iteration-1.tar.gz");
    expect(entries.find(e => e.name === "run-002/iteration-1.tar.gz")!.data).toEqual(snapshotData);
  });

  it("bundles HAR and chat export files", async () => {
    const { pack } = await import("tar-stream");
    const p = pack();
    const harData = Buffer.from('{"log":{}}');
    const chatData = Buffer.from('{"messages":[]}');
    const container = makeMockBlobContainer({
      "run-003/capture.har": { body: harData, length: harData.length },
      "run-003/chat-export.json": { body: chatData, length: chatData.length },
    });

    const run: ArchivableRun = {
      _id: "run-003",
      run: {
        harUrl: "https://storage.blob.core.windows.net/snapshots/run-003/capture.har",
        rawChatUrl: "https://storage.blob.core.windows.net/snapshots/run-003/chat-export.json",
        turns: [],
      },
    };

    const entriesPromise = collectPackEntries(p);
    await packRunIntoTar(p, run, container, "run-003", () => true);
    p.finalize();

    const entries = await entriesPromise;
    const names = entries.map(e => e.name);
    expect(names).toContain("run-003/run.yaml");
    expect(names).toContain("run-003/run.har");
    expect(names).toContain("run-003/run.chat-export.json");
  });

  it("skips missing blobs when isRestError returns true", async () => {
    const { pack } = await import("tar-stream");
    const p = pack();
    const container = makeMockBlobContainer({}); // no blobs — all downloads will fail

    const run: ArchivableRun = {
      _id: "run-004",
      run: {
        turns: [
          { iteration: 1, snapshotUrl: "https://storage.blob.core.windows.net/snapshots/run-004/iteration-1/workspace.tar.gz" },
        ],
      },
    };

    const entriesPromise = collectPackEntries(p);
    // isRestError returns true for all errors → blobs are skipped
    await packRunIntoTar(p, run, container, "run-004", () => true);
    p.finalize();

    const entries = await entriesPromise;
    // Only run.yaml should be present; the snapshot was skipped
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("run-004/run.yaml");
  });

  it("uses custom prefix for tar entries", async () => {
    const { pack } = await import("tar-stream");
    const p = pack();
    const container = makeMockBlobContainer();

    const run: ArchivableRun = {
      _id: "run-005",
      run: {
        turns: [],
      },
    };

    const entriesPromise = collectPackEntries(p);
    await packRunIntoTar(p, run, container, "custom-prefix", () => true);
    p.finalize();

    const entries = await entriesPromise;
    expect(entries[0].name).toBe("custom-prefix/run.yaml");
  });
});
