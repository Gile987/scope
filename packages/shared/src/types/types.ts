// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig } from './mcp.js';

// Multi-turn conversation turn (one coding + judge iteration)
export interface ConversationTurn {
  iteration: number;
  codingAgentResponse: string;
  judgeFeedback: string;
  snapshotUrl: string;
  passed: boolean;
  timestamp: Date;
  criteriaResults?: CriterionResult[];  // Per-criterion breakdown from DAG evaluation
}

// Multi-turn configuration constants
export const MULTI_TURN_DEFAULTS = {
  MAX_ITERATIONS: 10,
  ITERATION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
  VISIBILITY_TIMEOUT_SECONDS: 35 * 60,   // 35 minutes (must exceed max iteration time)
} as const;

// --- Persona & Scenario types (mirrors prototype config schema) ---

export type Personality = "demanding" | "friendly";
export type Experience = "junior" | "senior";
export type Verbosity = "brief" | "moderate";
export type UserType = "traditional" | "ai_assisted" | "vibe";

export interface Persona {
  personality: Personality;
  experience: Experience;
  verbosity: Verbosity;
  type: UserType;
}

export interface Scenario {
  version?: 'v1' | 'v2';  // v1 = simple strings (default), v2 = criteria IDs
  task: string;
  criteria: string[];  // v1: prompts, v2: criteria IDs
}

export interface TraitDescriptions {
  personality: Record<Personality, string>;
  experience: Record<Experience, string>;
  verbosity: Record<Verbosity, string>;
  type: Record<UserType, string>;
}

// Coding agent definition stored in MongoDB
export interface CodingAgentDocument {
  _id: string;               // Agent ID (e.g. "coder-acp-copilot")
  name: string;              // Display name
  description?: string;
  supportedModels: string[];  // Empty array = model selection disabled
  defaultModel?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;           // Soft-delete timestamp
}

// Model document stored in MongoDB — tracks lifecycle of scanned models
export interface ModelDocument {
  _id: string;                     // Compound: "{agentId}:{modelId}" for uniqueness
  modelId: string;                 // Model identifier (e.g. "gpt-4.1")
  provider: string;                // Provider identifier (e.g. "github-copilot", "anthropic")
  agentId: string;                 // Which coding agent this model was discovered for
  firstSeenAt: Date;               // First time our scanner discovered this model
  lastSeenAt: Date;                // Last scan where this model was still present
  disappearedAt?: Date;            // Set when a previously-seen model is no longer returned by the provider
  providerAvailableFrom?: Date;    // Provider-reported availability date
  providerEndOfLife?: Date;        // Provider-reported planned end-of-life / deprecation date
  metadata?: Record<string, unknown>; // Additional provider-specific metadata
}

// Request document stored in MongoDB
export interface RequestDocument {
  _id: string;  // UUID as _id (for CosmosDB sharding compatibility)
  scenario: Scenario;            // The task + criteria (source of truth)
  workerType: string;
  model?: string;              // Model selected for this run
  status: "pending" | "processing" | "iterating" | "completed" | "failed" | "exhausted";
  result?: string;
  error?: string;
  logs: LogEvent[];
  createdAt: Date;
  updatedAt?: Date;
  // Multi-turn fields
  maxIterations?: number;
  turns?: ConversationTurn[];
  personaInstructions?: string;  // Resolved persona prose (from traits.yaml)
  persona?: Persona;             // Original persona object for traceability
  deletedAt?: Date;              // Soft-delete timestamp (null/absent = active)
  taskPromptId?: string;            // Materialized UUIDv5 of scenario.task (FK → TaskPromptDocument._id)
  promptFeatureExtractionId?: string; // @deprecated — use TaskPromptDocument.features via taskPromptId instead
  mcpServers?: string[];          // MCP server slugs selected for this run
}

// Log event for real-time streaming and persistence
export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

// Queue message payload
export interface QueueMessagePayload {
  requestId: string;
}

// Options passed to worker processor
export interface WorkerProcessorOptions {
  model?: string;
  mcpServerConfigs?: McpServerConfig[];  // Resolved MCP server configurations
}

// Worker processor interface - each worker implements this
export interface WorkerProcessor {
  readonly workerName: string;
  processMessage(message: string, log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>, options?: WorkerProcessorOptions): Promise<string>;
}

// Base configuration for queue processors
export interface BaseQueueProcessorConfig {
  mongoUri: string;
  mongoDatabase: string;
  mongoCollection: string;
  storageAccountName: string;
  storageConnectionString?: string; // For local Azurite
  queueName: string;
  batchSize: number;
  pollIntervalMs: number;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
}

// Configuration for the coding agent queue processor
export interface QueueProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string; // For auto-triggering report generation via REST API
}

// --- Enhanced Criteria System types ---

// Criteria definition (loaded from config/criteria/*.yaml for v2 scenarios)
export interface CriteriaConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];  // Optional parent criteria IDs
}

// Per-criterion result from judge evaluation
export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;  // False if skipped due to ancestor failure
}

// Enhanced evaluation result with per-criterion results
export interface DetailedEvaluationResult {
  allPassed: boolean;
  results: CriterionResult[];
  evaluatedIds: Set<string>;
  strategy: 'bundled' | 'independent';
}

// Judge strategy configuration (from environment/ConfigMap)
export interface JudgeStrategyConfig {
  type: 'bundled' | 'independent';
  maxParallelism?: number;  // For independent strategy (default: 3)
}

// Feedback configuration (from environment/ConfigMap)
export interface FeedbackConfig {
  maxCriteria?: number;  // Max failed criteria to include (default: 1)
  includeDescendantGuard?: boolean;  // Avoid hinting at dependent criteria (default: true)
}

// Criteria document stored in MongoDB (extends CriteriaConfig with DB metadata)
export interface CriteriaDocument extends CriteriaConfig {
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;  // Soft-delete timestamp
}

// --- Report System types ---

export type ReportStatus = "pending" | "generating" | "completed" | "failed";

/** Reporter identity — describes what generated the report */
export interface Reporter {
  id: string;            // Hardcoded worker slug, e.g. "report-generator"
  name: string;          // Human-readable, e.g. "Report Generator"
  gitHash: string;       // Build-time GIT_COMMIT
  model: string;         // Runtime REPORT_MODEL, e.g. "gpt-4.1"
  agentId: string;       // Agent platform identifier, e.g. "copilot-sdk"
  agentVersion: string;  // @github/copilot-sdk package version
}

/** Report document stored in MongoDB */
export interface ReportDocument {
  _id: string;           // UUID
  requestId: string;     // FK → RequestDocument._id
  reporter?: Reporter;   // Set by the worker when it picks up the job
  content?: string;      // Generated markdown report
  status: ReportStatus;
  error?: string;
  logs: LogEvent[];
  insightReferences?: InsightReference[];  // Insights discovered/referenced by this report
  createdAt: Date;
  updatedAt?: Date;
}

/** Queue message payload for report generation */
export interface ReportQueueMessagePayload {
  reportId: string;
}

// --- Insights System types ---

/** Reference from a report to an insight */
export interface InsightReference {
  insightId: string;     // FK → InsightDocument._id
  referencedAt: Date;    // When the reference was made
  isNew: boolean;        // True if this report created the insight, false if referencing existing
}

/** Insight document stored in MongoDB */
export interface InsightDocument {
  _id: string;           // UUID
  title: string;         // Short summary (one line)
  /** Markdown-formatted detailed observation */
  description: string;
  category?: string;     // Grouping tag (e.g. "agent-behavior", "criteria-handling", "tool-usage")
  tags?: string[];       // Free-form tags for search
  upvotes: number;       // Simple counter (default 0)
  downvotes: number;     // Simple counter (default 0)
  blocked: boolean;      // Whether this insight is blocked (default false)
  referenceCount: number; // How many reports reference this insight
  createdBy: "agent" | "user";  // Who initially created the insight
  sourceReportId?: string;      // FK → ReportDocument._id (if agent-created)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;      // Soft-delete timestamp
}

// --- Task Prompt System types ---
// Task prompts are immutable, content-addressed entities identified by UUIDv5(text, namespace).
// Runs reference task prompts via a materialized taskPromptId derived from scenario.task.

/** Task prompt document stored in MongoDB. Immutable — text cannot be changed after creation. */
export interface TaskPromptDocument {
  _id: string;                          // UUIDv5 of text.trim() (content-addressed)
  text: string;                         // Full task prompt text
  features?: PromptFeatureResult[];     // Detected prompt features
  featuresExtractedAt?: Date;           // When features were last extracted
  createdAt: Date;
  deletedAt?: Date;                     // Soft-delete timestamp
}

// --- Prompt Features System types ---
// Prompt features describe detectable characteristics of a task prompt
// (analogous to criteria which describe detectable characteristics of a codebase)

/** Prompt feature definition (loaded from config/prompt-features/*.yaml) */
export interface PromptFeatureConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];  // Optional parent prompt feature IDs
}

/** Prompt feature document stored in MongoDB (extends PromptFeatureConfig with DB metadata) */
export interface PromptFeatureDocument extends PromptFeatureConfig {
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;  // Soft-delete timestamp
}

/** Per-feature result from LLM extraction */
export interface PromptFeatureResult {
  featureId: string;
  detected: boolean;
  evaluated: boolean;  // False if skipped due to ancestor not detected
}

/** A prompt feature suggested by the LLM during extraction (not yet in the registry) */
export interface SuggestedPromptFeature {
  suggestedId: string;
  behavior: string;
  prompt: string;
}

/** Stored extraction result — maps a task prompt to its detected features */
export interface PromptFeatureExtraction {
  _id?: string;
  taskText: string;
  taskTextHash?: string;
  promptFeatureResults: PromptFeatureResult[];
  suggestedFeatures?: SuggestedPromptFeature[];
  extractedAt: Date;
  model?: string;
  cached?: boolean;
}
