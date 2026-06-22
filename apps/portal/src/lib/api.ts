// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run, RunState, CriteriaDocument, CriteriaGraphData, GeneratePromptResponse, AnalysisResponse, PromptFeatureDocument, Report, BulkReportStatus, BulkReportSummary, ReportTemplate, ReportTrigger, ReportTemplateSystemPrompt, KeyDocument, KeyValidationResult, CreateKeyRequest, UpdateKeyRequest, CodingAgent, AgentVersion, McpServerDocument, CreateMcpServerRequest, UpdateMcpServerRequest, BulkResubmitOverrides, Insight, InsightWithReference, TaskPrompt, TaskPromptFeatureExtractionResult, Model, FeatureFlag, SkillDocument, SkillSearchResult, SkillDiscoveryResult, SkillRevisionDocument, ExtensionDocument, ExtensionSearchResult, ExtensionVersionInfo, MdpResponse, AccountDocument, CreateAccountRequest, UpdateAccountRequest, ProfileWithVersion, ProfileVersionDocument, ProfileDocument, RunGroup, CursorPaginatedResponse, IterationOp, GateConfig, GateId, PromptType } from "@/types";

import { qs } from "./url";
import { recordServerDate } from "./serverClock";

const BASE = "/api/v1";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  // Sample the server's wall-clock from the standard HTTP `Date` header so
  // relative-time displays survive a misconfigured local clock.
  recordServerDate(res.headers.get("Date"));
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = body.error || `HTTP ${res.status}`;
    const details = body.details as Array<{ path: string; message: string }> | undefined;
    if (details?.length) {
      throw new Error(`${message}: ${details.map((d) => `${d.path || "body"}: ${d.message}`).join(", ")}`);
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  /** List runs with cursor-based pagination */
  listRuns: (opts?: { worker?: string; taskPromptId?: string; status?: string; outcome?: string; criteria?: string; submissionId?: string; profileId?: string; turns?: number; turnsOp?: IterationOp; maxIterations?: number; maxIterationsOp?: IterationOp; limit?: number; after?: string; before?: string; last?: boolean }): Promise<CursorPaginatedResponse<Run>> => {
    return request(`/requests${qs({
      worker: opts?.worker,
      taskPromptId: opts?.taskPromptId,
      status: opts?.status,
      outcome: opts?.outcome,
      criteria: opts?.criteria,
      submissionId: opts?.submissionId,
      profileId: opts?.profileId,
      turns: opts?.turns !== undefined ? String(opts.turns) : undefined,
      turnsOp: opts?.turns !== undefined ? opts?.turnsOp : undefined,
      maxIterations: opts?.maxIterations !== undefined ? String(opts.maxIterations) : undefined,
      maxIterationsOp: opts?.maxIterations !== undefined ? opts?.maxIterationsOp : undefined,
      limit: opts?.limit ? String(opts.limit) : undefined,
      after: opts?.after,
      before: opts?.before,
      last: opts?.last ? "true" : undefined,
    })}`);
  },

  /** List runs grouped by task or submissionId, with cursor-based pagination */
  listRunGroups: (opts: { groupBy: "task" | "submissionId" | "profile"; worker?: string; taskPromptId?: string; status?: string; outcome?: string; criteria?: string; submissionId?: string; turns?: number; turnsOp?: IterationOp; maxIterations?: number; maxIterationsOp?: IterationOp; limit?: number; after?: string; before?: string; last?: boolean }): Promise<CursorPaginatedResponse<RunGroup>> => {
    return request(`/requests${qs({
      groupBy: opts.groupBy,
      worker: opts.worker,
      taskPromptId: opts.taskPromptId,
      status: opts.status,
      outcome: opts.outcome,
      criteria: opts.criteria,
      submissionId: opts.submissionId,
      turns: opts.turns !== undefined ? String(opts.turns) : undefined,
      turnsOp: opts.turns !== undefined ? opts.turnsOp : undefined,
      maxIterations: opts.maxIterations !== undefined ? String(opts.maxIterations) : undefined,
      maxIterationsOp: opts.maxIterations !== undefined ? opts.maxIterationsOp : undefined,
      limit: opts.limit ? String(opts.limit) : undefined,
      after: opts.after,
      before: opts.before,
      last: opts.last ? "true" : undefined,
    })}`);
  },

  /** Get a single run by ID */
  getRun: (id: string): Promise<Run> => {
    return request(`/requests/${id}`);
  },

  /** Submit a new run (or multiple runs if count > 1) */
  submitRun: (body: {
    scenario: { task: string; criteria: string[]; version?: "v1" | "v2" };
    worker?: string;
    model?: string;
    reasoningEffort?: string;
    maxIterations?: number;
    personaInstructions?: string;
    persona?: { personality: string; experience: string; verbosity: string; type: string };
    count?: number;
    mcpServers?: string[];
    skills?: string[];
    extensions?: string[];
    agentVersion?: string;
    profileId?: string;
    profileVariations?: string[];
    gates?: GateConfig[];
  }): Promise<(Run & { message: string }) | { ids: string[]; count: number; message: string }> => {
    const { worker, ...payload } = body;
    const url = worker ? `/requests?worker=${encodeURIComponent(worker)}` : `/requests`;
    return request(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** Soft-delete a run */
  deleteRun: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/requests/${id}`, { method: "DELETE" });
  },

  /** Retry a request (start a new attempt) */
  retryRun: (id: string, options?: { force?: boolean }): Promise<{ requestId: string; runId: string; attemptNumber: number }> => {
    return request(`/requests/${id}/retry`, {
      method: "POST",
      body: options?.force ? JSON.stringify({ force: true }) : undefined,
    });
  },

  /** Pause a request */
  pauseRun: (id: string): Promise<{ id: string; status: string }> => {
    return request(`/requests/${id}/pause`, { method: "POST" });
  },

  /** Cancel a request (marks as failed and signals worker to exit) */
  cancelRun: (id: string): Promise<{ id: string; previousStatus: string; status: string; outcome: string }> => {
    return request(`/requests/${id}/cancel`, { method: "POST" });
  },

  /** Resume a paused request */
  resumeRun: (id: string): Promise<{ id: string; status: string }> => {
    return request(`/requests/${id}/resume`, { method: "POST" });
  },

  /** Set priority for a request */
  setPriority: (id: string, priority: number): Promise<{ id: string; priority: number }> => {
    return request(`/requests/${id}/priority`, {
      method: "POST",
      body: JSON.stringify({ priority }),
    });
  },

  /** List all attempts for a request (current + historical) */
  listRunAttempts: (id: string): Promise<RunState[]> => {
    return request(`/requests/${id}/runs`);
  },

  /** Bulk retry multiple requests */
  bulkRetryRuns: (ids: string[], options?: { force?: boolean }): Promise<{ retried: number; skipped: number; results: Array<{ requestId: string; runId?: string; attemptNumber?: number; error?: string }> }> => {
    return request(`/requests/bulk-retry`, {
      method: "POST",
      body: JSON.stringify({ ids, force: options?.force }),
    });
  },

  /** Bulk pause multiple requests */
  bulkPauseRuns: (ids: string[]): Promise<{ paused: number; skipped: number }> => {
    return request(`/requests/bulk-pause`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  },

  /** Bulk resume multiple requests */
  bulkResumeRuns: (ids: string[]): Promise<{ resumed: number; skipped: number }> => {
    return request(`/requests/bulk-resume`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  },

  /** Bulk set priority for multiple requests */
  bulkSetPriority: (ids: string[], priority: number): Promise<{ updated: number }> => {
    return request(`/requests/bulk-priority`, {
      method: "POST",
      body: JSON.stringify({ ids, priority }),
    });
  },

  /** Bulk soft-delete multiple runs */
  bulkDeleteRuns: (ids: string[]): Promise<{ deleted: number; notFound: string[] }> => {
    return request(`/requests/bulk`, {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });
  },

  /** Bulk re-submit runs (create new runs from existing ones) */
  bulkResubmitRuns: (ids: string[], count = 1, overrides?: BulkResubmitOverrides): Promise<{ submitted: number; failed: string[]; newIds: string[] }> => {
    return request(`/requests/bulk-resubmit`, {
      method: "POST",
      body: JSON.stringify({ ids, count, ...(overrides ? { overrides } : {}) }),
    });
  },

  /** Get snapshot download URL for a specific iteration */
  snapshotUrl: (id: string, iteration: number): string => {
    return `${BASE}/requests/${id}/snapshots/${iteration}`;
  },

  /** Get HAR file download URL for a request (optionally per-iteration) */
  harUrl: (id: string, iteration?: number): string => {
    const qs = iteration ? `?iteration=${iteration}` : "";
    return `${BASE}/requests/${id}/har${qs}`;
  },

  /** Get tool-calls JSONL download URL for a per-iteration turn */
  toolCallsUrl: (id: string, iteration: number): string => {
    return `${BASE}/requests/${id}/tool-calls?iteration=${iteration}`;
  },

  /** Get full run archive download URL (.tar.gz with run.yaml + iteration snapshots) */
  archiveUrl: (id: string): string => {
    return `${BASE}/requests/${id}/archive`;
  },

  /** Get ATIF trajectory download URL */
  atifUrl: (id: string, iteration?: number): string => {
    const qs = iteration ? `?iteration=${iteration}` : "";
    return `${BASE}/requests/${id}/atif${qs}`;
  },

  /** Download a batch archive of multiple runs as a single .tar.gz */
  batchArchive: async (ids: string[]): Promise<void> => {
    const resp = await fetch(`${BASE}/requests/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    recordServerDate(resp.headers.get("Date"));
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error ?? "Failed to download batch archive");
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `batch-${timestamp}.tar.gz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /** Get video stream URL for a request (optionally per-iteration, per-index, or setup phase) */
  videoUrl: (id: string, iteration?: number, index = 0, phase?: string): string => {
    const params = new URLSearchParams();
    if (phase) params.set("phase", phase);
    if (iteration) params.set("iteration", String(iteration));
    if (index > 0) params.set("index", String(index));
    const qs = params.toString();
    return `${BASE}/requests/${id}/video${qs ? `?${qs}` : ""}`;
  },

  /** SSE endpoint URL for log streaming */
  logsUrl: (id: string, fromStart = true): string => {
    return `${BASE}/requests/${id}/logs?fromStart=${fromStart}`;
  },

  // ─── Per-run artifact URLs (for historical attempts) ─────────────────────

  /** SSE endpoint URL for log streaming of a specific attempt */
  runLogsUrl: (requestId: string, runId: string, fromStart = true): string => {
    return `${BASE}/requests/${requestId}/runs/${runId}/logs?fromStart=${fromStart}`;
  },

  /** HAR file download URL for a specific attempt */
  runHarUrl: (requestId: string, runId: string, iteration?: number): string => {
    const qs = iteration ? `?iteration=${iteration}` : "";
    return `${BASE}/requests/${requestId}/runs/${runId}/har${qs}`;
  },

  /** Video stream URL for a specific attempt */
  runVideoUrl: (requestId: string, runId: string, iteration?: number, index = 0, phase?: string): string => {
    const params = new URLSearchParams();
    if (phase) params.set("phase", phase);
    if (iteration) params.set("iteration", String(iteration));
    if (index > 0) params.set("index", String(index));
    const qs = params.toString();
    return `${BASE}/requests/${requestId}/runs/${runId}/video${qs ? `?${qs}` : ""}`;
  },

  /** Tool-calls JSONL URL for a specific attempt */
  runToolCallsUrl: (requestId: string, runId: string, iteration: number): string => {
    return `${BASE}/requests/${requestId}/runs/${runId}/tool-calls?iteration=${iteration}`;
  },

  /** Full run archive download URL for a specific attempt */
  runArchiveUrl: (requestId: string, runId: string): string => {
    return `${BASE}/requests/${requestId}/runs/${runId}/archive`;
  },

  /** Snapshot download URL for a specific attempt */
  runSnapshotUrl: (requestId: string, runId: string, iteration: number): string => {
    return `${BASE}/requests/${requestId}/runs/${runId}/snapshots/${iteration}`;
  },

  // ─── Criteria ──────────────────────────────────────────────────────────────

  /** List all criteria, optionally filtered by search query or IDs with ancestor resolution */
  listCriteria: (q?: string, opts?: { ids?: string[]; ancestors?: boolean }): Promise<CriteriaDocument[]> => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (opts?.ids && opts.ids.length > 0) params.set("ids", opts.ids.join(","));
    if (opts?.ancestors) params.set("ancestors", "true");
    const qs = params.toString();
    return request(`/criteria${qs ? `?${qs}` : ""}`);
  },

  /** Get a single criterion by ID */
  getCriterion: (id: string): Promise<CriteriaDocument & { dependents: string[] }> => {
    return request(`/criteria/${id}`);
  },

  /** Create a new criterion */
  createCriterion: (body: { id: string; prompt: string; dependsOn?: string[]; gates?: GateId[] }): Promise<CriteriaDocument> => {
    return request("/criteria", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an existing criterion */
  updateCriterion: (id: string, body: { prompt?: string; dependsOn?: string[]; gates?: GateId[] }): Promise<CriteriaDocument> => {
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
  generateCriteriaPrompt: (behavior: string, currentId?: string, gates?: string[]): Promise<GeneratePromptResponse> => {
    return request("/criteria/generate-prompt", {
      method: "POST",
      body: JSON.stringify({ behavior, ...(currentId && { currentId }), ...(gates && gates.length > 0 && { gates }) }),
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
  createPromptFeature: (body: { id: string; prompt: string }): Promise<PromptFeatureDocument> => {
    return request("/prompt-features", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an existing prompt feature */
  updatePromptFeature: (id: string, body: { prompt?: string }): Promise<PromptFeatureDocument> => {
    return request(`/prompt-features/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Delete a prompt feature */
  deletePromptFeature: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/prompt-features/${id}`, { method: "DELETE" });
  },

  /** Generate a prompt feature prompt from a behavior description using AI */
  generatePromptFeaturePrompt: (behavior: string, currentId?: string): Promise<GeneratePromptResponse> => {
    return request("/prompt-features/generate-prompt", {
      method: "POST",
      body: JSON.stringify({ behavior, ...(currentId && { currentId }) }),
    });
  },

  // ─── Task Prompts ──────────────────────────────────────────────────────────

  /** List all task prompts (paginated, optional search) */
  listTaskPrompts: (opts?: { limit?: number; offset?: number; search?: string; type?: PromptType }): Promise<{ items: TaskPrompt[]; total: number }> => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.search) params.set("search", opts.search);
    if (opts?.type) params.set("type", opts.type);
    const qs = params.toString();
    return request(`/task-prompts${qs ? `?${qs}` : ""}`);
  },

  /** Get a single task prompt by ID */
  getTaskPrompt: (id: string): Promise<TaskPrompt> => {
    return request(`/task-prompts/${encodeURIComponent(id)}`);
  },

  /** Create (or find existing) task prompt — idempotent */
  createTaskPrompt: (text: string, type?: PromptType): Promise<TaskPrompt> => {
    return request("/task-prompts", {
      method: "POST",
      body: JSON.stringify({ text, ...(type ? { type } : {}) }),
    });
  },

  /** Soft-delete a task prompt */
  deleteTaskPrompt: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/task-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** AI-generate a task prompt from a description or create a variation */
  generateTaskPrompt: (opts: { description?: string; existingPrompt?: string }): Promise<{ taskPrompt: string; tasks?: string[] }> => {
    return request("/task-prompts/generate", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  },

  /** Extract prompt features for a task prompt entity */
  extractTaskPromptFeatures: (id: string, opts?: { model?: string; force?: boolean }): Promise<TaskPromptFeatureExtractionResult> => {
    const url = opts?.force ? `/task-prompts/${encodeURIComponent(id)}/extract-features?force=true` : `/task-prompts/${encodeURIComponent(id)}/extract-features`;
    return request(url, {
      method: "POST",
      body: JSON.stringify({ ...(opts?.model && { model: opts.model }) }),
    });
  },

  /** Extract features from raw text without persisting a task prompt entity */
  extractFeaturesFromText: (text: string, opts?: { model?: string }): Promise<TaskPromptFeatureExtractionResult> => {
    return request(`/prompt-features/extract-from-text`, {
      method: "POST",
      body: JSON.stringify({ text, ...(opts?.model && { model: opts.model }) }),
    });
  },

  /** Toggle a single feature's detected status on a task prompt */
  toggleTaskPromptFeature: (id: string, featureId: string, detected: boolean): Promise<TaskPrompt> => {
    return request(`/task-prompts/${encodeURIComponent(id)}/features/${encodeURIComponent(featureId)}`, {
      method: "PATCH",
      body: JSON.stringify({ detected }),
    });
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

  /** List versions for an agent */
  listAgentVersions: (agentId: string, status?: string): Promise<AgentVersion[]> => {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return request(`/agents/${encodeURIComponent(agentId)}/versions${params}`);
  },

  /** Update an agent version's status */
  updateAgentVersionStatus: (agentId: string, agentVersion: string, status: "active" | "retired"): Promise<AgentVersion> => {
    return request(`/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(agentVersion)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
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

  // ─── MDP ────────────────────────────────────────────────────────────────────

  /** Get MDP state-transition graph (optionally incremental via since) */
  getMdp: (criteria?: string[], since?: string, features?: string[]): Promise<MdpResponse> => {
    const params = new URLSearchParams();
    if (criteria && criteria.length > 0) {
      params.set("criteria", criteria.join(","));
    }
    if (features && features.length > 0) {
      params.set("features", features.join(","));
    }
    if (since) {
      params.set("since", since);
    }
    const qs = params.toString();
    return request(`/criteria/mdp${qs ? `?${qs}` : ""}`);
  },

  // ─── Reports ──────────────────────────────────────────────────────────────

  /** Trigger report generation for a run — evaluates all templates and creates one report per match */
  triggerReports: (requestId: string): Promise<{ triggered: number; reports: { id: string; requestId: string; templateId?: string; status: string }[] }> => {
    return request("/reports/trigger", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    });
  },

  /** Create a single report for a run (optionally with a specific template) */
  createReport: (requestId: string, templateId?: string): Promise<{ id: string; requestId: string; status: string }> => {
    return request("/reports", {
      method: "POST",
      body: JSON.stringify({ requestId, ...(templateId ? { templateId } : {}) }),
    });
  },

  /** Bulk trigger reports for multiple runs (evaluates all templates per run) */
  bulkTriggerReports: (requestIds: string[]): Promise<{ created: number; reports: { reportId: string; requestId: string; templateId?: string }[]; notFound: string[] }> => {
    return request("/reports/bulk-trigger", {
      method: "POST",
      body: JSON.stringify({ requestIds }),
    });
  },

  /** Bulk create reports for multiple runs (legacy, no template evaluation) */
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

  /** Bulk report summary for multiple runs (returns status counts per requestId) */
  bulkReportSummary: (requestIds: string[]): Promise<BulkReportSummary> => {
    return request("/reports/bulk-summary", {
      method: "POST",
      body: JSON.stringify({ requestIds }),
    });
  },

  /** SSE endpoint URL for report log streaming */
  reportLogsUrl: (id: string, fromStart = true): string => {
    return `${BASE}/reports/${id}/logs?fromStart=${fromStart}`;
  },

  // ─── Report Templates ─────────────────────────────────────────────────────

  /** Get the default system prompt used when no template override is set */
  getDefaultSystemPrompt: (): Promise<{ content: string }> => {
    return request("/report-templates/default-system-prompt");
  },

  /** List all report templates */
  listReportTemplates: (): Promise<ReportTemplate[]> => {
    return request("/report-templates");
  },

  /** Get a single report template by slug ID */
  getReportTemplate: (id: string): Promise<ReportTemplate> => {
    return request(`/report-templates/${id}`);
  },

  /** List models available for report generation */
  listAvailableReportModels: (): Promise<Array<{ modelId: string }>> => {
    return request("/report-templates/available-models");
  },

  /** Create a new report template */
  createReportTemplate: (body: {
    id: string;
    name: string;
    userPrompt: string;
    description?: string;
    systemPrompt?: ReportTemplateSystemPrompt;
    trigger?: ReportTrigger;
    model?: string;
    timeoutMs?: number;
  }): Promise<ReportTemplate> => {
    return request("/report-templates", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update an existing report template */
  updateReportTemplate: (id: string, body: {
    name?: string;
    description?: string;
    userPrompt?: string;
    systemPrompt?: ReportTemplateSystemPrompt | null;
    trigger?: ReportTrigger | null;
    model?: string | null;
    timeoutMs?: number | null;
  }): Promise<ReportTemplate> => {
    return request(`/report-templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Delete a report template (soft-delete) */
  deleteReportTemplate: (id: string): Promise<void> => {
    return request(`/report-templates/${id}`, { method: "DELETE" });
  },

  // ─── Version ───────────────────────────────────────────────────────────────

  /** Get API version information (commit hash and build time) */
  getVersion: (): Promise<{ commit: string; buildTime: string; environment?: string }> => {
    return request("/version");
  },

  /** Get API readiness and migration status (hits root-level /ready, not /api/v1) */
  getReadiness: async (): Promise<{ status: string; migrations: { ready: boolean; applied: string[]; pending: string[]; totalApplied: number } }> => {
    const res = await fetch("/ready");
    // /ready returns 503 when not ready — we still want the JSON body
    if (!res.ok && res.status !== 503) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  },

  // ─── Key Manager ──────────────────────────────────────────────────────────

  /** List all keys (metadata only), optionally filtered by capability */
  listKeys: (capability?: string): Promise<KeyDocument[]> => {
    const params = new URLSearchParams();
    if (capability) params.set("capability", capability);
    const qs = params.toString();
    return request(`/keys${qs ? `?${qs}` : ""}`);
  },

  /** Get a single key by ID */
  getKey: (id: string): Promise<KeyDocument> => {
    return request(`/keys/${id}`);
  },

  /** Preview key — validate without storing */
  previewKey: (body: { type: string; value: string }): Promise<KeyValidationResult> => {
    return request("/keys/preview", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Register a new key */
  createKey: (body: CreateKeyRequest): Promise<KeyDocument> => {
    return request("/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update key metadata (enabled, expiresAt) */
  updateKey: (id: string, body: UpdateKeyRequest): Promise<KeyDocument> => {
    return request(`/keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete a key */
  deleteKey: (id: string): Promise<void> => {
    return request(`/keys/${id}`, { method: "DELETE" });
  },

  /** Trigger on-demand validation for a key */
  validateKey: (id: string): Promise<KeyDocument> => {
    return request(`/keys/${id}/validate`, { method: "POST" });
  },

  // ─── Accounts ─────────────────────────────────────────────────────────────

  /** List all accounts (metadata only) */
  listAccounts: (): Promise<AccountDocument[]> => {
    return request("/accounts");
  },

  /** Get a single account by ID */
  getAccount: (id: string): Promise<AccountDocument> => {
    return request(`/accounts/${id}`);
  },

  /** Register a new account */
  createAccount: (body: CreateAccountRequest): Promise<AccountDocument> => {
    return request("/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update account metadata + optionally rotate secrets */
  updateAccount: (id: string, body: UpdateAccountRequest): Promise<AccountDocument> => {
    return request(`/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete an account */
  deleteAccount: (id: string): Promise<void> => {
    return request(`/accounts/${id}`, { method: "DELETE" });
  },

  // ─── Insights ──────────────────────────────────────────────────────────────

  /** List all insights (with optional text search and blocked filter) */
  listInsights: (q?: string, blocked?: boolean): Promise<Insight[]> => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (blocked !== undefined) params.set("blocked", String(blocked));
    const qs = params.toString();
    return request(`/insights${qs ? `?${qs}` : ""}`);
  },

  /** Search insights by keyword (fuzzy match) */
  searchInsights: (q: string): Promise<Insight[]> => {
    return request(`/insights/search?q=${encodeURIComponent(q)}`);
  },

  /** Get a single insight by ID */
  getInsight: (id: string): Promise<Insight> => {
    return request(`/insights/${id}`);
  },

  /** Create a new insight */
  createInsight: (body: { title: string; description: string; category?: string; tags?: string[] }): Promise<Insight> => {
    return request("/insights", {
      method: "POST",
      body: JSON.stringify({ ...body, createdBy: "user" }),
    });
  },

  /** Update an insight */
  updateInsight: (id: string, body: { title?: string; description?: string; category?: string; tags?: string[] }): Promise<Insight> => {
    return request(`/insights/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete an insight */
  deleteInsight: (id: string): Promise<void> => {
    return request(`/insights/${id}`, { method: "DELETE" });
  },

  /** Upvote an insight */
  upvoteInsight: (id: string): Promise<Insight> => {
    return request(`/insights/${id}/upvote`, { method: "POST" });
  },

  /** Downvote an insight */
  downvoteInsight: (id: string): Promise<Insight> => {
    return request(`/insights/${id}/downvote`, { method: "POST" });
  },

  /** Block an insight */
  blockInsight: (id: string): Promise<Insight> => {
    return request(`/insights/${id}/block`, { method: "POST" });
  },

  /** Unblock an insight */
  unblockInsight: (id: string): Promise<Insight> => {
    return request(`/insights/${id}/unblock`, { method: "POST" });
  },

  /** Get reports that reference a specific insight */
  getInsightReports: (insightId: string): Promise<Report[]> => {
    return request(`/insights/${insightId}/reports`);
  },

  /** Get insights referenced by a specific report */
  getReportInsights: (reportId: string): Promise<InsightWithReference[]> => {
    return request(`/reports/${reportId}/insights`);
  },

  // ─── Models ────────────────────────────────────────────────────────────────

  /** List all scanned models, optionally filtered by agentId or provider */
  listModels: (params?: { agentId?: string; provider?: string; status?: "active" | "disappeared" }): Promise<Model[]> => {
    const searchParams = new URLSearchParams();
    if (params?.agentId) searchParams.set("agentId", params.agentId);
    if (params?.provider) searchParams.set("provider", params.provider);
    if (params?.status) searchParams.set("status", params.status);
    const qs = searchParams.toString();
    return request(`/models${qs ? `?${qs}` : ""}`);
  },

  /** Get a single model by compound ID */
  getModel: (id: string): Promise<Model> => {
    return request(`/models/${encodeURIComponent(id)}`);
  },

  // ─── Feature Flags ──────────────────────────────────────────────────────────

  /** List all feature flags */
  listFeatureFlags: (): Promise<FeatureFlag[]> => {
    return request("/feature-flags");
  },

  /** Update a feature flag's enabled state */
  updateFeatureFlag: (key: string, enabled: boolean): Promise<FeatureFlag> => {
    return request(`/feature-flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  },

  // ─── Skills ───────────────────────────────────────────────────────────────

  /** List all imported skills */
  listSkills: (): Promise<SkillDocument[]> => {
    return request("/skills");
  },

  /** Get a single skill by slug */
  getSkill: (slug: string): Promise<SkillDocument> => {
    return request(`/skills/${slug}`);
  },

  /** Search skills in the internal library and the external skills.sh registry */
  searchSkills: (query: string, limit?: number): Promise<SkillSearchResult[]> => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set("limit", String(limit));
    return request(`/skills/search?${params}`);
  },

  /** Search external skills registry only */
  searchExternalSkills: (query: string, limit?: number): Promise<SkillSearchResult[]> => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set("limit", String(limit));
    return request(`/skills/search/external?${params}`);
  },

  /** Discover skills available in a GitHub repo by scanning well-known directories */
  discoverSkills: (source: string): Promise<SkillDiscoveryResult[]> => {
    const params = new URLSearchParams({ source });
    return request(`/skills/discover?${params}`);
  },

  /** Import a skill */
  createSkill: (body: { source: string; skillName: string; name: string; origin: string; description?: string }): Promise<SkillDocument> => {
    return request("/skills", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete a skill */
  deleteSkill: (slug: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/skills/${slug}`, { method: "DELETE" });
  },

  /** Resolve a skill (create/update revision from GitHub) */
  resolveSkill: (slug: string): Promise<SkillRevisionDocument> => {
    return request(`/skills/${slug}/resolve`, { method: "POST" });
  },

  /** List revisions for a skill */
  listSkillRevisions: (slug: string): Promise<SkillRevisionDocument[]> => {
    return request(`/skills/${slug}/revisions`);
  },

  // ─── Extensions ──────────────────────────────────────────────────────────

  /** List all imported extensions */
  listExtensions: (): Promise<ExtensionDocument[]> => {
    return request("/extensions");
  },

  /** Get a single extension by ID */
  getExtension: (id: string): Promise<ExtensionDocument> => {
    return request(`/extensions/${id}`);
  },

  /** Search extensions (internal + VS Code marketplace) */
  searchExtensions: (query: string, limit?: number): Promise<ExtensionSearchResult[]> => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set("limit", String(limit));
    return request(`/extensions/search?${params}`);
  },

  /** Import an extension */
  createExtension: (body: { _id: string; publisher: string; name: string; origin: string; description?: string }): Promise<ExtensionDocument> => {
    return request("/extensions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** List available versions for an extension from the VS Code marketplace */
  getExtensionVersions: (id: string, preRelease = false): Promise<ExtensionVersionInfo[]> => {
    const params = new URLSearchParams();
    if (preRelease) params.set("preRelease", "true");
    return request(`/extensions/${id}/versions?${params}`);
  },

  /** Soft-delete an extension */
  deleteExtension: (id: string): Promise<{ id: string; deleted: boolean }> => {
    return request(`/extensions/${id}`, { method: "DELETE" });
  },

  // ─── Profiles ────────────────────────────────────────────────────────────

  /** List all profiles (latest version of each) */
  listProfiles: (opts?: { workerType?: string }): Promise<ProfileWithVersion[]> => {
    const params = new URLSearchParams();
    if (opts?.workerType) params.set("workerType", opts.workerType);
    return request(`/profiles?${params}`);
  },

  /** Get a profile with its latest version */
  getProfile: (profileId: string): Promise<ProfileWithVersion> => {
    return request(`/profiles/${profileId}`);
  },

  /** List all versions of a profile */
  listProfileVersions: (profileId: string): Promise<ProfileVersionDocument[]> => {
    return request(`/profiles/${profileId}/versions`);
  },

  /** Get a specific version of a profile */
  getProfileVersion: (profileId: string, version: number): Promise<ProfileVersionDocument> => {
    return request(`/profiles/${profileId}/versions/${version}`);
  },

  /** Create a new profile (version 1) */
  createProfile: (body: {
    name: string;
    description?: string;
    workerType: string;
    model: string;
    agentVersion?: string;
    mcpServers?: string[];
    skillRevisions?: string[];
    extensions?: string[];
  }): Promise<ProfileWithVersion> => {
    return request("/profiles", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Create a new version of an existing profile */
  createProfileVersion: (profileId: string, body: {
    workerType: string;
    model: string;
    agentVersion?: string;
    mcpServers?: string[];
    skillRevisions?: string[];
    extensions?: string[];
  }): Promise<ProfileVersionDocument> => {
    return request(`/profiles/${profileId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** Update profile identity (name/description) */
  updateProfileIdentity: (profileId: string, body: {
    name?: string;
    description?: string;
  }): Promise<ProfileDocument> => {
    return request(`/profiles/${profileId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Soft-delete a profile */
  deleteProfile: (profileId: string): Promise<void> => {
    return request(`/profiles/${profileId}`, { method: "DELETE" });
  },
};
