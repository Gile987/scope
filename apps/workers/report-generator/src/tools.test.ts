// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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

describe("createReportTools", () => {
  let tools: any[];
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    tools = createReportTools({ apiBaseUrl: API_BASE, reportId: REPORT_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 3 insight tools", () => {
    expect(tools).toHaveLength(3);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("search_insights");
    expect(names).toContain("create_insight");
    expect(names).toContain("reference_insight");
  });

  describe("search_insights", () => {
    it("searches and returns mapped results", async () => {
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

    it("returns error on API failure", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(null, false, 500));
      const tool = findTool(tools, "search_insights");
      const result = await tool.handler({ query: "test" });
      expect(result.error).toContain("Failed to search insights: 500");
    });
  });

  describe("create_insight", () => {
    it("creates and links to report", async () => {
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

    it("reports warning if link fails", async () => {
      const insight = { _id: "i-new", title: "New finding" };
      fetchMock
        .mockResolvedValueOnce(mockResponse(insight))
        .mockResolvedValueOnce(mockResponse(null, false, 500));

      const tool = findTool(tools, "create_insight");
      const result = await tool.handler({
        title: "New finding",
        description: "Description here",
      });

      expect(result.id).toBe("i-new");
      expect(result.warning).toContain("failed to link");
    });
  });

  describe("reference_insight", () => {
    it("links existing insight to report", async () => {
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

    it("returns error on API failure", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ error: "Not found" }, false, 404));
      const tool = findTool(tools, "reference_insight");
      const result = await tool.handler({ insightId: "bad-id" });
      expect(result.error).toContain("Not found");
    });
  });
});
