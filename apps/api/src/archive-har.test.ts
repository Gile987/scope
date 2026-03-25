// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import {
  blobNameFromSnapshotsUrl,
  rewriteHarUrlsForArchive,
  detectBundledHarFiles,
  uploadBundledHarFiles,
  type BlobUploader,
} from "./archive-har.js";

// --- rewriteHarUrlsForArchive ---

describe("rewriteHarUrlsForArchive", () => {
  it("rewrites top-level harUrl to run.har", () => {
    const resource = {
      harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/capture.har",
      turns: [],
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.harUrl).toBe("run.har");
  });

  it("rewrites per-turn harUrl to iteration-N.har", () => {
    const resource = {
      turns: [
        { iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-1/capture.har" },
        { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
      ],
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.turns![0].harUrl).toBe("iteration-1.har");
    expect(result.turns![1].harUrl).toBe("iteration-2.har");
  });

  it("leaves turns without harUrl unchanged", () => {
    const resource = {
      turns: [
        { iteration: 1, snapshotUrl: "https://example.com/snap" },
        { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
      ],
    };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.turns![0].harUrl).toBeUndefined();
    expect(result.turns![1].harUrl).toBe("iteration-2.har");
  });

  it("handles resource with no harUrl at all", () => {
    const resource = { turns: [{ iteration: 1 }] };
    const result = rewriteHarUrlsForArchive(resource);
    expect(result.harUrl).toBeUndefined();
    expect(result.turns![0].harUrl).toBeUndefined();
  });

  it("does not mutate the original resource", () => {
    const resource = {
      harUrl: "https://storage.blob.core.windows.net/snapshots/abc/capture.har",
      turns: [{ iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har" }],
    };
    rewriteHarUrlsForArchive(resource);
    expect(resource.harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/capture.har");
    expect(resource.turns[0].harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har");
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
    const turns = [
      { iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: false },
      { iteration: 2, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: false },
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
    const turns = [{ iteration: 1, codingAgentResponse: "", judgeFeedback: "", snapshotUrl: "", passed: false }];

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
