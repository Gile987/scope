// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Types mirroring the API response shapes (from shared/src/types.ts)

export type RunStatus = "pending" | "processing" | "iterating" | "completed" | "failed";

export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;
}

export interface ConversationTurn {
  iteration: number;
  codingAgentResponse: string;
  judgeFeedback: string;
  snapshotUrl: string;
  passed: boolean;
  timestamp: string;
  criteriaResults?: CriterionResult[];
}

export interface Scenario {
  version?: "v1" | "v2";
  task: string;
  criteria: string[];
}

export interface Persona {
  personality: string;
  experience: string;
  verbosity: string;
  type: string;
}

export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Run {
  _id: string;
  id: string;
  scenario: Scenario;
  workerType: string;
  status: RunStatus;
  result?: string;
  error?: string;
  logs?: LogEvent[];
  maxIterations?: number;
  turns?: ConversationTurn[];
  personaInstructions?: string;
  persona?: Persona;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export const WORKER_TYPES = [
  "coder-acp-claude-code",
  "coder-acp-copilot",
  "coder-vscode-web",
] as const;

export type WorkerType = (typeof WORKER_TYPES)[number];

export const STATUS_LIST: RunStatus[] = [
  "pending",
  "processing",
  "iterating",
  "completed",
  "failed",
];

// Criteria types
export interface CriteriaConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

export interface CriteriaDocument extends CriteriaConfig {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface CriteriaGraphData {
  nodes: Array<{ id: string; prompt: string; dependsOn: string[] }>;
  edges: Array<{ source: string; target: string }>;
}

export interface GeneratePromptResponse {
  prompt: string;
  suggestedId: string;
}
