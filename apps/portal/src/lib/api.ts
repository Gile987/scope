// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run, CriteriaDocument, CriteriaGraphData, GeneratePromptResponse, AnalysisResponse, PromptFeatureDocument, PromptFeatureGraphData, PromptFeatureExtraction, Report, BulkReportStatus, TokenDocument, TokenValidationResult, CreateTokenRequest, UpdateTokenRequest, CodingAgent, McpServerDocument, CreateMcpServerRequest, UpdateMcpServerRequest } from "@/types";

const BASE = "/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  /** List all runs, optionally filtered by worker */
  listRuns: (worker?: string): Promise<Run[]> => {
    const params = new URLSearchParams();
    if (worker) params.set("worker", worker);
    const qs = params.toString();
    return request(`/requests${qs ? `?${qs}` : ""}`);
  },

  /** Get a single run by ID */
  getRun: (id: string): Promise<Run> => {
    return request(`/requests/${id}`);
  },

  /** Submit a new run (or multiple runs if count > 1) */
  submitRun: (body: {
    scenario: { task: string; criteria: string[]; version?: "v1" | "v2" };
    worker: string;
    model?: string;
    maxIterations?: number;
    personaInstructions?: string;
    persona?: { personality: string; experience: string; verbosity: string; type: string };
    count?: number;
    promptFeatureExtractionId?: string;
    mcpServers?: string[];
  }): Promise<(Run & { message: string }) | { ids: string[]; count: number; message: string }> => {
    const { worker, ...payload } = body;
    return request(`/requests?worker=${encodeURIComponent(worker)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** Soft-delete a run */
  deleteRun: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/requests/${id}`, { method: "DELETE" });
  },

  /** Bulk soft-delete multiple runs */
  bulkDeleteRuns: (ids: string[]): Promise<{ deleted: number; notFound: string[] }> => {
    return request(`/requests/bulk`, {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });
  },

  /** Bulk re-submit runs (create new runs from existing ones) */
  bulkResubmitRuns: (ids: string[], count = 1): Promise<{ submitted: number; failed: string[]; newIds: string[] }> => {
    return request(`/requests/bulk-resubmit`, {
      method: "POST",
      body: JSON.stringify({ ids, count }),
    });
  },

  /** Get snapshot download URL for a specific iteration */
  snapshotUrl: (id: string, iteration: number): string => {
    return `${BASE}/requests/${id}/snapshots/${iteration}`;
  },

  /** SSE endpoint URL for log streaming */
  logsUrl: (id: string, fromStart = true): string => {
    return `${BASE}/requests/${id}/logs?fromStart=${fromStart}`;
  },

  // ─── Criteria ──────────────────────────────────────────────────────────────

  /** List all criteria, optionally filtered by search query */
  listCriteria: (q?: string): Promise<CriteriaDocument[]> => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const qs = params.toString();
    return request(`/criteria${qs ? `?${qs}` : ""}`);
  },

  /** Get a single criterion by ID */
  getCriterion: (id: string): Promise<CriteriaDocument & { dependents: string[] }> => {
    return request(`/criteria/${id}`);
  },

  /** Create a new criterion */
  createCriterion: (body: { id: string; prompt: string; dependsOn?: string[] }): Promise<CriteriaDocument> => {
    return request("/criteria", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an existing criterion */
  updateCriterion: (id: string, body: { prompt?: string; dependsOn?: string[] }): Promise<CriteriaDocument> => {
    return request(`/criteria/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Delete a criterion */
  deleteCriterion: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/criteria/${id}`, { method: "DELETE" });
  },

  /** Get the full criteria dependency graph */
  getCriteriaGraph: (): Promise<CriteriaGraphData> => {
    return request("/criteria/graph");
  },

  /** Generate a criteria prompt from a behavior description using AI */
  generateCriteriaPrompt: (behavior: string, currentId?: string): Promise<GeneratePromptResponse> => {
    return request("/criteria/generate-prompt", {
      method: "POST",
      body: JSON.stringify({ behavior, ...(currentId && { currentId }) }),
    });
  },

  // ─── Prompt Features ───────────────────────────────────────────────────────

  /** List all prompt features, optionally filtered by search query */
  listPromptFeatures: (q?: string): Promise<PromptFeatureDocument[]> => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const qs = params.toString();
    return request(`/prompt-features${qs ? `?${qs}` : ""}`);
  },

  /** Get a single prompt feature by ID */
  getPromptFeature: (id: string): Promise<PromptFeatureDocument & { dependents: string[] }> => {
    return request(`/prompt-features/${id}`);
  },

  /** Create a new prompt feature */
  createPromptFeature: (body: { id: string; prompt: string; dependsOn?: string[] }): Promise<PromptFeatureDocument> => {
    return request("/prompt-features", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an existing prompt feature */
  updatePromptFeature: (id: string, body: { prompt?: string; dependsOn?: string[] }): Promise<PromptFeatureDocument> => {
    return request(`/prompt-features/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Delete a prompt feature */
  deletePromptFeature: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/prompt-features/${id}`, { method: "DELETE" });
  },

  /** Get the full prompt feature dependency graph */
  getPromptFeatureGraph: (): Promise<PromptFeatureGraphData> => {
    return request("/prompt-features/graph");
  },

  /** Generate a prompt feature prompt from a behavior description using AI */
  generatePromptFeaturePrompt: (behavior: string, currentId?: string): Promise<GeneratePromptResponse> => {
    return request("/prompt-features/generate-prompt", {
      method: "POST",
      body: JSON.stringify({ behavior, ...(currentId && { currentId }) }),
    });
  },

  /** Extract prompt features from a task text */
  extractPromptFeatures: (taskText: string, model?: string, force?: boolean): Promise<PromptFeatureExtraction> => {
    const url = force ? "/prompt-features/extract?force=true" : "/prompt-features/extract";
    return request(url, {
      method: "POST",
      body: JSON.stringify({ taskText, ...(model && { model }) }),
    });
  },

  /** Get a single prompt feature extraction by ID */
  getPromptFeatureExtraction: (id: string): Promise<PromptFeatureExtraction> => {
    return request(`/prompt-features/extractions/${encodeURIComponent(id)}`);
  },

  // ─── Agents ─────────────────────────────────────────────────────────────────

  /** List all coding agents */
  listAgents: (): Promise<CodingAgent[]> => {
    return request("/agents");
  },

  /** Get a single coding agent by ID */
  getAgent: (id: string): Promise<CodingAgent> => {
    return request(`/agents/${encodeURIComponent(id)}`);
  },

  /** Update a coding agent */
  updateAgent: (id: string, body: Partial<Pick<CodingAgent, 'name' | 'description' | 'supportedModels' | 'defaultModel'>>): Promise<CodingAgent> => {
    return request(`/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete a coding agent */
  deleteAgent: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // ─── MCP Servers ────────────────────────────────────────────────────────────

  /** List all MCP servers */
  listMcpServers: (): Promise<McpServerDocument[]> => {
    return request("/mcp/servers");
  },

  /** Get a single MCP server by slug */
  getMcpServer: (slug: string): Promise<McpServerDocument> => {
    return request(`/mcp/servers/${encodeURIComponent(slug)}`);
  },

  /** Create a new MCP server (upsert by slug) */
  createMcpServer: (body: CreateMcpServerRequest): Promise<McpServerDocument> => {
    return request("/mcp/servers", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an MCP server */
  updateMcpServer: (slug: string, body: UpdateMcpServerRequest): Promise<McpServerDocument> => {
    return request(`/mcp/servers/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete an MCP server */
  deleteMcpServer: (slug: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/mcp/servers/${encodeURIComponent(slug)}`, { method: "DELETE" });
  },

  // ─── Analysis ──────────────────────────────────────────────────────────────

  /** Get analysis data for statistics dashboard */
  getAnalysis: (kValues: number[] = [1, 2, 5], criteria?: string[]): Promise<AnalysisResponse> => {
    const params = new URLSearchParams();
    params.set("k", kValues.join(","));
    if (criteria && criteria.length > 0) {
      params.set("criteria", criteria.join(","));
    }
    return request(`/analysis?${params.toString()}`);
  },

  // ─── Reports ──────────────────────────────────────────────────────────────

  /** Create a report for a run */
  createReport: (requestId: string): Promise<{ id: string; requestId: string; status: string }> => {
    return request("/reports", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    });
  },

  /** Bulk create reports for multiple runs */
  bulkCreateReports: (requestIds: string[]): Promise<{ created: number; reports: { reportId: string; requestId: string }[]; notFound: string[] }> => {
    return request("/reports/bulk-create", {
      method: "POST",
      body: JSON.stringify({ requestIds }),
    });
  },

  /** List all reports, optionally filtered by requestId */
  listReports: (requestId?: string): Promise<Report[]> => {
    const params = new URLSearchParams();
    if (requestId) params.set("requestId", requestId);
    const qs = params.toString();
    return request(`/reports${qs ? `?${qs}` : ""}`);
  },

  /** Get a single report by ID */
  getReport: (id: string): Promise<Report> => {
    return request(`/reports/${id}`);
  },

  /** Get reports for a specific run */
  getRunReports: (requestId: string): Promise<Report[]> => {
    return request(`/requests/${requestId}/reports`);
  },

  /** Bulk report status for multiple runs (returns latest report status per requestId) */
  bulkReportStatus: (requestIds: string[]): Promise<BulkReportStatus> => {
    return request("/reports/bulk-status", {
      method: "POST",
      body: JSON.stringify({ requestIds }),
    });
  },

  /** SSE endpoint URL for report log streaming */
  reportLogsUrl: (id: string, fromStart = true): string => {
    return `${BASE}/reports/${id}/logs?fromStart=${fromStart}`;
  },

  // ─── Version ───────────────────────────────────────────────────────────────

  /** Get API version information (commit hash and build time) */
  getVersion: (): Promise<{ commit: string; buildTime: string }> => {
    return request("/version");
  },

  // ─── Token Manager ──────────────────────────────────────────────────────────

  /** List all tokens (metadata only), optionally filtered by capability */
  listTokens: (capability?: string): Promise<TokenDocument[]> => {
    const params = new URLSearchParams();
    if (capability) params.set("capability", capability);
    const qs = params.toString();
    return request(`/tokens${qs ? `?${qs}` : ""}`);
  },

  /** Get a single token by ID */
  getToken: (id: string): Promise<TokenDocument> => {
    return request(`/tokens/${id}`);
  },

  /** Preview token — validate without storing */
  previewToken: (body: { type: string; value: string }): Promise<TokenValidationResult> => {
    return request("/tokens/preview", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Register a new token */
  createToken: (body: CreateTokenRequest): Promise<TokenDocument> => {
    return request("/tokens", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update token metadata (enabled, expiresAt) */
  updateToken: (id: string, body: UpdateTokenRequest): Promise<TokenDocument> => {
    return request(`/tokens/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete a token */
  deleteToken: (id: string): Promise<void> => {
    return request(`/tokens/${id}`, { method: "DELETE" });
  },

  /** Trigger on-demand validation for a token */
  validateToken: (id: string): Promise<TokenDocument> => {
    return request(`/tokens/${id}/validate`, { method: "POST" });
  },
};
