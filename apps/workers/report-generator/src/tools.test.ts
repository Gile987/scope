// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock @github/copilot-sdk - capture handler functions via defineTool
vi.mock("@github/copilot-sdk", () => ({
  defineTool: (name: string, config: { handler: Function }) => ({
    name,
    handler: config.handler,
  }),
}));

import { createReportTools } from "./tools.js";

const API_BASE = "http://localhost:3000";
const REQUEST_ID = "req-123";
const SNAPSHOTS_DIR = "/tmp/test-snapshots";
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

describe("createReportTools - insight tools", () => {
  let tools: any[];
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    tools = createReportTools(API_BASE, REQUEST_ID, SNAPSHOTS_DIR, REPORT_ID);
  });

  it("returns 11 tools including insight tools", () => {
    expect(tools).toHaveLength(11);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("search_insights");
    expect(names).toContain("create_insight");
    expect(names).toContain("reference_insight");
  });

  describe("search_insights", () => {
    it("searches insights and returns mapped results", async () => {
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

      expect(result.error).toContain("Failed to search insights");
      expect(result.error).toContain("500");
    });

    it("returns error on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network error"));

      const tool = findTool(tools, "search_insights");
      const result = await tool.handler({ query: "test" });

      expect(result.error).toContain("Failed to search insights");
      expect(result.error).toContain("Network error");
    });
  });

  describe("create_insight", () => {
    it("creates insight and links to report", async () => {
      const createdInsight = { _id: "new-insight-1", title: "New finding" };
      fetchMock
        .mockResolvedValueOnce(mockResponse(createdInsight)) // POST /insights
        .mockResolvedValueOnce(mockResponse({ ok: true }));   // POST /reports/:id/insights

      const tool = findTool(tools, "create_insight");
      const result = await tool.handler({
        title: "New finding",
        description: "## Detail\nMore info here",
        category: "agent-behavior",
        tags: ["retry", "stubborn"],
      });

      // Verify create call
      expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/v1/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "New finding",
          description: "## Detail\nMore info here",
          category: "agent-behavior",
          tags: ["retry", "stubborn"],
          createdBy: "agent",
          sourceReportId: REPORT_ID,
        }),
      });

      // Verify reference call
      expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/v1/reports/${REPORT_ID}/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insightId: "new-insight-1", isNew: true }),
      });

      expect(result).toEqual({
        id: "new-insight-1",
        title: "New finding",
        created: true,
        linkedToReport: true,
      });
    });

    it("returns warning when created but link fails", async () => {
      const createdInsight = { _id: "new-insight-2", title: "Partial" };
      fetchMock
        .mockResolvedValueOnce(mockResponse(createdInsight))        // POST /insights OK
        .mockResolvedValueOnce(mockResponse(null, false, 500));     // POST /reports/:id/insights FAIL

      const tool = findTool(tools, "create_insight");
      const result = await tool.handler({ title: "Partial", description: "d" });

      expect(result.id).toBe("new-insight-2");
      expect(result.warning).toBe("Created but failed to link to report");
    });

    it("returns error when creation fails", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse(null, false, 400));

      const tool = findTool(tools, "create_insight");
      const result = await tool.handler({ title: "Fail", description: "d" });

      expect(result.error).toContain("Failed to create insight");
      expect(result.error).toContain("400");
    });

    it("sends createdBy agent and sourceReportId", async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ _id: "x", title: "t" }))
        .mockResolvedValueOnce(mockResponse({ ok: true }));

      const tool = findTool(tools, "create_insight");
      await tool.handler({ title: "t", description: "d" });

      const createCall = fetchMock.mock.calls[0];
      const body = JSON.parse(createCall[1].body);
      expect(body.createdBy).toBe("agent");
      expect(body.sourceReportId).toBe(REPORT_ID);
    });
  });

  describe("reference_insight", () => {
    it("references existing insight from report", async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

      const tool = findTool(tools, "reference_insight");
      const result = await tool.handler({ insightId: "existing-1" });

      expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/api/v1/reports/${REPORT_ID}/insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insightId: "existing-1", isNew: false }),
      });

      expect(result).toEqual({ insightId: "existing-1", referenced: true });
    });

    it("returns error from API response body", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: async () => ({ error: "Insight already referenced" }),
      });

      const tool = findTool(tools, "reference_insight");
      const result = await tool.handler({ insightId: "dup-1" });

      expect(result.error).toBe("Insight already referenced");
    });

    it("returns generic error when JSON parsing fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
        json: async () => { throw new Error("not json"); },
      });

      const tool = findTool(tools, "reference_insight");
      const result = await tool.handler({ insightId: "err-1" });

      expect(result.error).toContain("Failed to reference insight");
      expect(result.error).toContain("500");
    });

    it("returns error on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

      const tool = findTool(tools, "reference_insight");
      const result = await tool.handler({ insightId: "net-err" });

      expect(result.error).toContain("Failed to reference insight");
      expect(result.error).toContain("Connection refused");
    });
  });
});
