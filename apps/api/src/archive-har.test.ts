// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";

// Test the harUrl rewriting logic used in archive download
describe("archive HAR bundling — harUrl rewriting", () => {
  function rewriteHarUrls(resource: {
    harUrl?: string;
    turns?: Array<{ iteration: number; harUrl?: string; [key: string]: unknown }>;
  }) {
    // Mirrors the rewriting logic in the archive download handler
    const copy = JSON.parse(JSON.stringify(resource));
    if (copy.harUrl) {
      copy.harUrl = "run.har";
    }
    if (copy.turns) {
      for (const turn of copy.turns) {
        if (turn.harUrl) {
          turn.harUrl = `iteration-${turn.iteration}.har`;
        }
      }
    }
    return copy;
  }

  it("rewrites top-level harUrl to run.har", () => {
    const resource = {
      harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/capture.har",
      turns: [],
    };
    const result = rewriteHarUrls(resource);
    expect(result.harUrl).toBe("run.har");
  });

  it("rewrites per-turn harUrl to iteration-N.har", () => {
    const resource = {
      turns: [
        { iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-1/capture.har" },
        { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
      ],
    };
    const result = rewriteHarUrls(resource);
    expect(result.turns[0].harUrl).toBe("iteration-1.har");
    expect(result.turns[1].harUrl).toBe("iteration-2.har");
  });

  it("leaves turns without harUrl unchanged", () => {
    const resource = {
      turns: [
        { iteration: 1, snapshotUrl: "https://example.com/snap" },
        { iteration: 2, harUrl: "https://storage.blob.core.windows.net/snapshots/abc123/iteration-2/capture.har" },
      ],
    };
    const result = rewriteHarUrls(resource);
    expect(result.turns[0].harUrl).toBeUndefined();
    expect(result.turns[1].harUrl).toBe("iteration-2.har");
  });

  it("handles resource with no harUrl at all", () => {
    const resource = {
      turns: [{ iteration: 1 }],
    };
    const result = rewriteHarUrls(resource);
    expect(result.harUrl).toBeUndefined();
    expect(result.turns[0].harUrl).toBeUndefined();
  });

  it("does not mutate the original resource", () => {
    const resource = {
      harUrl: "https://storage.blob.core.windows.net/snapshots/abc/capture.har",
      turns: [{ iteration: 1, harUrl: "https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har" }],
    };
    rewriteHarUrls(resource);
    expect(resource.harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/capture.har");
    expect(resource.turns[0].harUrl).toBe("https://storage.blob.core.windows.net/snapshots/abc/iter-1/capture.har");
  });
});

// Test the blobNameFromUrl helper logic
describe("archive HAR bundling — blobNameFromUrl", () => {
  function blobNameFromUrl(url: string): string | null {
    const parsed = new URL(url);
    const prefix = "/snapshots/";
    const idx = parsed.pathname.indexOf(prefix);
    return idx === -1 ? null : parsed.pathname.substring(idx + prefix.length);
  }

  it("extracts blob name from Azure Blob Storage URL", () => {
    const url = "https://mystorageaccount.blob.core.windows.net/snapshots/abc123/iteration-1/capture.har";
    expect(blobNameFromUrl(url)).toBe("abc123/iteration-1/capture.har");
  });

  it("extracts blob name from Azurite URL", () => {
    const url = "http://127.0.0.1:10000/devstoreaccount1/snapshots/abc123/capture.har";
    expect(blobNameFromUrl(url)).toBe("abc123/capture.har");
  });

  it("returns null when URL has no snapshots container", () => {
    const url = "https://mystorageaccount.blob.core.windows.net/other-container/abc123/file.har";
    expect(blobNameFromUrl(url)).toBeNull();
  });
});

// Test HAR file detection logic used in upload/import
describe("archive HAR import — file detection", () => {
  function detectHarFiles(fileNames: string[]): {
    perTurn: Array<{ fileName: string; iteration: number }>;
    topLevel: string | null;
  } {
    const perTurn: Array<{ fileName: string; iteration: number }> = [];
    let topLevel: string | null = null;

    for (const name of fileNames.filter(n => n.endsWith(".har"))) {
      const iterMatch = name.match(/^iteration-(\d+)\.har$/);
      if (iterMatch) {
        perTurn.push({ fileName: name, iteration: parseInt(iterMatch[1], 10) });
      } else if (name === "run.har") {
        topLevel = name;
      }
    }

    return { perTurn, topLevel };
  }

  it("detects per-turn HAR files", () => {
    const files = ["iteration-1.har", "iteration-2.har", "iteration-1.tar.gz", "run.yaml"];
    const result = detectHarFiles(files);
    expect(result.perTurn).toEqual([
      { fileName: "iteration-1.har", iteration: 1 },
      { fileName: "iteration-2.har", iteration: 2 },
    ]);
    expect(result.topLevel).toBeNull();
  });

  it("detects top-level run.har", () => {
    const files = ["run.yaml", "run.har", "iteration-1.tar.gz"];
    const result = detectHarFiles(files);
    expect(result.topLevel).toBe("run.har");
    expect(result.perTurn).toEqual([]);
  });

  it("detects both per-turn and top-level HAR files", () => {
    const files = ["run.yaml", "run.har", "iteration-1.har", "iteration-2.har", "iteration-1.tar.gz"];
    const result = detectHarFiles(files);
    expect(result.topLevel).toBe("run.har");
    expect(result.perTurn).toHaveLength(2);
  });

  it("returns empty when no HAR files present", () => {
    const files = ["run.yaml", "iteration-1.tar.gz", "iteration-2.tar.gz"];
    const result = detectHarFiles(files);
    expect(result.perTurn).toEqual([]);
    expect(result.topLevel).toBeNull();
  });

  it("ignores HAR files with unexpected names", () => {
    const files = ["random.har", "other-file.har", "run.yaml"];
    const result = detectHarFiles(files);
    expect(result.perTurn).toEqual([]);
    expect(result.topLevel).toBeNull();
  });
});
