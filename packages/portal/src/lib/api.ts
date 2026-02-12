// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run, CriteriaDocument, CriteriaGraphData, GeneratePromptResponse, AnalysisResponse } from "@/types";

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

  /** Submit a new run */
  submitRun: (body: {
    scenario: { task: string; criteria: string[]; version?: "v1" | "v2" };
    worker: string;
    maxIterations?: number;
    personaInstructions?: string;
    persona?: { personality: string; experience: string; verbosity: string; type: string };
  }): Promise<Run & { message: string }> => {
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

  // ─── Analysis ──────────────────────────────────────────────────────────────

  /** Get analysis data for insights dashboard */
  getAnalysis: (kValues: number[] = [1, 2, 5]): Promise<AnalysisResponse> => {
    const ks = kValues.join(",");
    return request(`/analysis?k=${ks}`);
  },
};
