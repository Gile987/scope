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

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  response?: string;
  timestamp?: string;
}

export interface ConversationTurn {
  iteration: number;
  codingAgentResponse: string;
  judgeFeedback: string;
  snapshotUrl: string;
  passed: boolean;
  timestamp: string;
  criteriaResults?: CriterionResult[];
  toolCalls?: ToolCall[];
  harUrl?: string;
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
  model?: string;
  agentVersion?: string;
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
  taskPromptId?: string;
  /** @deprecated — use taskPromptId instead */
  promptFeatureExtractionId?: string;
  mcpServers?: string[];
  toolCalls?: ToolCall[];
  harUrl?: string;
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

export interface SuggestedPromptFeature {
  suggestedId: string;
  behavior: string;
  prompt: string;
}

export interface PromptFeatureExtraction {
  _id?: string;
  taskText: string;
  taskTextHash?: string;
  promptFeatureResults: PromptFeatureResult[];
  suggestedFeatures?: SuggestedPromptFeature[];
  extractedAt: string;
  model?: string;
  cached?: boolean;
}

// Task Prompt types (first-class entity for benchmark task texts)
export interface TaskPrompt {
  _id: string;                          // UUIDv5 content-addressed ID
  text: string;                         // Full task prompt text
  features?: PromptFeatureResult[];     // Detected prompt features
  featuresExtractedAt?: string;         // When features were last extracted
  createdAt: string;
  deletedAt?: string;
}

/** Response shape from feature extraction endpoints */
export interface TaskPromptFeatureExtractionResult {
  taskPromptId?: string;
  features: PromptFeatureResult[];
  featuresExtractedAt?: string;
  suggestedFeatures?: SuggestedPromptFeature[];
  cached: boolean;
}

// Analysis types for statistics dashboard
export interface TaskWorkerGroup {
  task: string;
  taskPromptId: string;
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

// Bulk re-submit overrides
export interface BulkResubmitOverrides {
  workerType?: string;
  model?: string | null;
  maxIterations?: number | null;
  mcpServers?: string[] | null;
}

// Bulk re-submit response
export interface BulkResubmitResponse {
  submitted: number;
  failed: string[];
  newIds: string[];
}

// Report types
export type ReportStatus = "pending" | "generating" | "completed" | "failed";

export interface Reporter {
  id: string;
  name: string;
  gitHash: string;
  model: string;
  agentId: string;
  agentVersion: string;
}

export interface Report {
  _id: string;
  id: string;
  requestId: string;
  task?: string;
  reporter?: Reporter;
  content?: string;
  status: ReportStatus;
  error?: string;
  logs: LogEvent[];
  insightReferences?: InsightReference[];
  templateId?: string;
  createdAt: string;
  updatedAt?: string;
}

export const REPORT_STATUS_LIST: ReportStatus[] = [
  "pending",
  "generating",
  "completed",
  "failed",
];

export interface BulkReportStatus {
  [requestId: string]: { reportId: string; status: ReportStatus };
}

// =============================================================================
// Report Template types
// =============================================================================

export type ReportTriggerType = "always" | "criteria" | "taskPrompt" | "promptFeature";

export interface AlwaysTrigger {
  type: "always";
}

export interface CriteriaTrigger {
  type: "criteria";
  criteriaIds: string[];
  match?: "any" | "all";
}

export interface TaskPromptTrigger {
  type: "taskPrompt";
  taskPromptIds: string[];
}

export interface PromptFeatureTrigger {
  type: "promptFeature";
  featureIds: string[];
  match?: "any" | "all";
}

export type ReportTrigger =
  | AlwaysTrigger
  | CriteriaTrigger
  | TaskPromptTrigger
  | PromptFeatureTrigger;

export interface ReportTemplateSystemPrompt {
  mode: "append" | "override";
  content: string;
}

export interface ReportTemplate {
  _id: string;
  id: string;
  name: string;
  description?: string;
  userPrompt: string;
  systemPrompt?: ReportTemplateSystemPrompt;
  trigger?: ReportTrigger;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

// =============================================================================
// Token Manager types
// =============================================================================

export type TokenType =
  | "github-pat-classic"
  | "github-pat-fine-grained"
  | "github-oauth"
  | "github-oauth-cookie-state"
  | "anthropic-api-key";

export type TokenCapability =
  "github-models" | "copilot-sdk" | "copilot-cli" | "claude-code-cli";

export type TokenValidationStatus =
  | "valid"
  | "invalid"
  | "expired"
  | "error"
  | "unknown";

export interface TokenDocument {
  _id: string;
  type: TokenType;
  capabilities: TokenCapability[];
  secretName: string;
  expiresAt?: string;
  lastValidatedAt?: string;
  lastValidationStatus: TokenValidationStatus;
  lastValidationError?: string;
  enabled: boolean;
  comment?: string;
  acquireCount: number;
  lastAcquiredAt?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface TokenValidationResult {
  status: TokenValidationStatus;
  scopes?: string[];
  capabilities?: TokenCapability[];
  expiresAt?: string;
  error?: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: string;
  };
}

export interface CreateTokenRequest {
  type: TokenType;
  value: string;
  expiresAt?: string;
  enabled?: boolean;
  comment?: string;
}

export interface UpdateTokenRequest {
  enabled?: boolean;
  expiresAt?: string | null;
  comment?: string | null;
}

export const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
  "github-pat-classic": "GitHub PAT (classic)",
  "github-pat-fine-grained": "GitHub PAT (fine-grained)",
  "github-oauth": "GitHub OAuth",
  "github-oauth-cookie-state": "GitHub OAuth Cookie State",
  "anthropic-api-key": "Anthropic API Key",
};

export const TOKEN_CAPABILITY_LABELS: Record<TokenCapability, string> = {
  "github-models": "GitHub Models",
  "copilot-sdk": "Copilot SDK",
  "copilot-cli": "Copilot CLI",
  "claude-code-cli": "Claude Code CLI"
};

export const TOKEN_CAPABILITY_DESCRIPTIONS: Record<TokenCapability, string> = {
  "github-models": "Access AI models hosted on GitHub (GPT-4o, Claude, etc.)",
  "copilot-sdk": "Use the Copilot SDK to make LLM requests programmatically",
  "copilot-cli": "Run GitHub Copilot in the CLI for code suggestions",
  "claude-code-cli": "Run Claude Code as an agentic coding assistant"
};

export const ALL_CAPABILITIES: TokenCapability[] = [
  "github-models", "copilot-sdk", "copilot-cli", "claude-code-cli"
];

// Coding Agent types
export interface CodingAgent {
  _id: string;
  name: string;
  description?: string;
  supportedModels: string[];
  defaultModel?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

// MCP Server types
export type McpTransportType = "sse" | "http";

export interface McpServerHeader {
  name: string;
  value: string;
}

export interface McpServerDocument {
  _id: string;
  name: string;
  type: McpTransportType;
  url: string;
  headers?: McpServerHeader[];
  description?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface CreateMcpServerRequest {
  _id: string;
  name: string;
  type: McpTransportType;
  url: string;
  headers?: McpServerHeader[];
  description?: string;
}

export interface UpdateMcpServerRequest {
  name?: string;
  type?: McpTransportType;
  url?: string;
  headers?: McpServerHeader[];
  description?: string;
}

// =============================================================================
// Insight types
// =============================================================================

/** Reference from a report to an insight */
export interface InsightReference {
  insightId: string;
  referencedAt: string;
  isNew: boolean;
}

/** Insight entity */
export interface Insight {
  _id: string;
  id: string;
  title: string;
  /** Markdown-formatted detailed observation */
  description: string;
  category?: string;
  tags?: string[];
  upvotes: number;
  downvotes: number;
  blocked: boolean;
  referenceCount: number;
  createdBy: "agent" | "user";
  sourceReportId?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** Insight enriched with reference metadata (when fetched via report) */
export interface InsightWithReference extends Insight {
  referencedAt?: string;
  isNew?: boolean;
}

// =============================================================================
// Model types
// =============================================================================

/** A scanned model tracked across agents and providers */
export interface Model {
  _id: string;
  modelId: string;
  provider: string;
  agentId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  disappearedAt?: string;
  providerAvailableFrom?: string;
  providerEndOfLife?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Feature flag types
// =============================================================================

/** A runtime feature flag controlling portal feature visibility */
export interface FeatureFlag {
  key: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
}
