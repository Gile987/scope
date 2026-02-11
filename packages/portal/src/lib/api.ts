// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run } from "@/types";

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

  /** Get snapshot download URL for a specific iteration */
  snapshotUrl: (id: string, iteration: number): string => {
    return `${BASE}/requests/${id}/snapshots/${iteration}`;
  },

  /** SSE endpoint URL for log streaming */
  logsUrl: (id: string, fromStart = true): string => {
    return `${BASE}/requests/${id}/logs?fromStart=${fromStart}`;
  },
};
