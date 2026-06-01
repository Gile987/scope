// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock @github/copilot-sdk - capture handler functions via defineTool
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: { handler: Function }) => ({
    name,
    handler: config.handler,
  }),
}));

import { createReportTools } from "./tools.js";

const API_BASE = "http://localhost:3000";
const REPORT_ID = "report-456";

/** Helper to find a tool by name from the tools array */
function findTool(tools: any[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

/** Build a mock Response object */
function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  };
}

describe("createReportTools - file tools", () => {
  let tools: any[];
  let archiveDir: string;

  beforeEach(() => {
    archiveDir = join(tmpdir(), `test-archive-${Date.now()}`);
    mkdirSync(archiveDir, { recursive: true });

    // Create test files in the archive
    writeFileSync(join(archiveDir, "run.yaml"), "scenario:\n  task: Build a web app\n");
    writeFileSync(join(archiveDir, "logs.jsonl"), '{"level":"info","msg":"start"}\n');
    mkdirSync(join(archiveDir, "snapshots", "iteration-1", "src"), { recursive: true });
    writeFileSync(join(archiveDir, "snapshots", "iteration-1", "src", "index.ts"), "console.log('hello');\n");

    tools = createReportTools({ archiveDir, apiBaseUrl: API_BASE, reportId: REPORT_ID });
  });

  afterEach(() => {
    rmSync(archiveDir, { recursive: true, force: true });
  });

  it("returns 6 tools", () => {
    expect(tools).toHaveLength(6);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("search_files");
    expect(names).toContain("search_insights");
    expect(names).toContain("create_insight");
    expect(names).toContain("reference_insight");
  });

  describe("read_file", () => {
    it("reads a file from the archive", async () => {
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "run.yaml" });
      expect(result.content).toContain("Build a web app");
    });

    it("reads nested files", async () => {
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "snapshots/iteration-1/src/index.ts" });
      expect(result.content).toContain("console.log");
    });

    it("returns error for non-existent file", async () => {
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "missing.txt" });
      expect(result.error).toContain("File not found");
    });

    it("prevents path traversal", async () => {
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "../../../etc/passwd" });
      expect(result.error).toContain("Path must be within the archive directory");
    });

    it("returns error for directories", async () => {
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "snapshots" });
      expect(result.error).toContain("is a directory");
    });

    it("truncates large files", async () => {
      const bigContent = "x".repeat(200_000);
      writeFileSync(join(archiveDir, "big.txt"), bigContent);
      const tool = findTool(tools, "read_file");
      const result = await tool.handler({ path: "big.txt" });
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(100_000);
      expect(result.totalSize).toBe(200_000);
    });
  });

  describe("list_directory", () => {
    it("lists archive root", async () => {
      const tool = findTool(tools, "list_directory");
      const result = await tool.handler({ path: "." });
      const names = result.entries.map((e: any) => e.name);
      expect(names).toContain("run.yaml");
      expect(names).toContain("logs.jsonl");
      expect(names).toContain("snapshots");
    });

    it("lists nested directory", async () => {
      const tool = findTool(tools, "list_directory");
      const result = await tool.handler({ path: "snapshots/iteration-1/src" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe("index.ts");
      expect(result.entries[0].type).toBe("file");
    });

    it("returns error for non-existent directory", async () => {
      const tool = findTool(tools, "list_directory");
      const result = await tool.handler({ path: "missing" });
      expect(result.error).toContain("Directory not found");
    });

    it("prevents path traversal", async () => {
      const tool = findTool(tools, "list_directory");
      const result = await tool.handler({ path: "../../" });
      expect(result.error).toContain("Path must be within the archive directory");
    });
  });

  describe("search_files", () => {
    it("finds matching content", async () => {
      const tool = findTool(tools, "search_files");
      const result = await tool.handler({ pattern: "hello" });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]).toContain("index.ts");
    });

    it("returns empty for no matches", async () => {
      const tool = findTool(tools, "search_files");
      const result = await tool.handler({ pattern: "nonexistentpattern12345" });
      expect(result.matches).toHaveLength(0);
    });
  });
});

describe("createReportTools - insight tools", () => {
  let tools: any[];
  let fetchMock: Mock;
  let archiveDir: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    archiveDir = join(tmpdir(), `test-archive-insights-${Date.now()}`);
    mkdirSync(archiveDir, { recursive: true });
    tools = createReportTools({ archiveDir, apiBaseUrl: API_BASE, reportId: REPORT_ID });
  });

  afterEach(() => {
    rmSync(archiveDir, { recursive: true, force: true });
  });

  it("search_insights searches and returns mapped results", async () => {
    const mockInsights = [
      { _id: "i1", title: "Agent retries", description: "Details", category: "agent-behavior", referenceCount: 3 },
      { _id: "i2", title: "Criteria flip-flop", description: "More", category: "criteria-handling", referenceCount: 1 },
    ];
    fetchMock.mockResolvedValueOnce(mockResponse(mockInsights));

    const tool = findTool(tools, "search_insights");
    const result = await tool.handler({ query: "agent retries" });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/insights/search?q=agent%20retries&blocked=false`
    );
    expect(result.total).toBe(2);
    expect(result.insights[0]).toEqual({
      id: "i1",
      title: "Agent retries",
      description: "Details",
      category: "agent-behavior",
      referenceCount: 3,
    });
  });

  it("search_insights returns error on API failure", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(null, false, 500));
    const tool = findTool(tools, "search_insights");
    const result = await tool.handler({ query: "test" });
    expect(result.error).toContain("Failed to search insights: 500");
  });

  it("create_insight creates and links to report", async () => {
    const insight = { _id: "i-new", title: "New finding" };
    fetchMock
      .mockResolvedValueOnce(mockResponse(insight))  // create
      .mockResolvedValueOnce(mockResponse({}));       // link

    const tool = findTool(tools, "create_insight");
    const result = await tool.handler({
      title: "New finding",
      description: "Description here",
      category: "agent-behavior",
    });

    expect(result.created).toBe(true);
    expect(result.linkedToReport).toBe(true);
    expect(result.id).toBe("i-new");
  });

  it("reference_insight links existing insight", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({}));

    const tool = findTool(tools, "reference_insight");
    const result = await tool.handler({ insightId: "i-existing" });

    expect(result.referenced).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/reports/${REPORT_ID}/insights`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ insightId: "i-existing", isNew: false }),
      })
    );
  });
});
