// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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

// Request document stored in MongoDB
export interface RequestDocument {
  _id: string;  // UUID as _id (for CosmosDB sharding compatibility)
  scenario: Scenario;            // The task + criteria (source of truth)
  workerType: string;
  status: "pending" | "processing" | "iterating" | "completed" | "failed";
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

// Worker processor interface - each worker implements this
export interface WorkerProcessor {
  readonly workerName: string;
  processMessage(message: string, log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>): Promise<string>;
}

// Configuration for the queue processor
export interface QueueProcessorConfig {
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
