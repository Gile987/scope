// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Types mirroring the API response shapes (from shared/src/types.ts)

export type RunStatus = "pending" | "processing" | "iterating" | "completed" | "failed" | "exhausted";

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
  scenario?: Scenario;
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
  promptFeatureExtractionId?: string;
}

export const WORKER_TYPES = [
  "coder-acp-claude-code",
  "coder-acp-copilot"
] as const;

export type WorkerType = (typeof WORKER_TYPES)[number];

export const STATUS_LIST: RunStatus[] = [
  "pending",
  "processing",
  "iterating",
  "completed",
  "failed",
  "exhausted",
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
  suggestedParents: string[];
  suggestedChildren: string[];
}

// Prompt Feature types
export interface PromptFeatureConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];
}

export interface PromptFeatureDocument extends PromptFeatureConfig {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface PromptFeatureGraphData {
  nodes: Array<{ id: string; prompt: string; dependsOn: string[] }>;
  edges: Array<{ source: string; target: string }>;
}

export interface PromptFeatureResult {
  featureId: string;
  detected: boolean;
  evaluated: boolean;
}

export interface PromptFeatureExtraction {
  _id?: string;
  taskText: string;
  taskTextHash?: string;
  promptFeatureResults: PromptFeatureResult[];
  extractedAt: string;
  model?: string;
  cached?: boolean;
}

// Analysis types for insights dashboard
export interface TaskWorkerGroup {
  task: string;
  workerType: string;
  total: number;
  completed: number;
  passed: number;
  rejected: number;
  passAtK: Record<number, number>;  // k -> probability
  successAtT: number[];  // CDF: index i = probability of success at ≤(i+1) iterations
  iterationStats: {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
  } | null;  // null if no passed runs
}

export interface AnalysisResponse {
  groups: TaskWorkerGroup[];
  kValues: number[];
  maxT: number;
  summary: {
    totalRuns: number;
    completedRuns: number;
    passedRuns: number;
    overallPassRate: number;
    avgIterationsToPass: number | null;
  };
  /** Union of all criteria IDs found across all runs (before filtering) */
  availableCriteria: string[];
  /** Criteria IDs that were used to define success (empty = use turn.passed) */
  selectedCriteria: string[];
}

// Bulk re-submit response
export interface BulkResubmitResponse {
  submitted: number;
  failed: string[];
  newIds: string[];
}
