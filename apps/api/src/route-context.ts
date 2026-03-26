// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Db } from "mongodb";
import type { QueueClient } from "@azure/storage-queue";
import type { BlobServiceClient } from "@azure/storage-blob";
import type { Express } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type {
  TaskPromptStore,
  TaskPromptDocument,
  SkillRevisionStore,
  SkillResolver,
  SkillDocument,
  SkillRevisionDocument,
} from "shared";

// ─── Document interfaces ─────────────────────────────────────────────────────
// These are the local document types currently defined in index.ts.
// They will migrate to shared Zod schemas over time (z.infer<>).

export interface CriteriaDocument {
  id: string;
  prompt: string;
  dependsOn?: string[];
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface PromptFeatureDocument {
  id: string;
  prompt: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface PromptFeatureExtractionDocument {
  _id?: string;
  taskText: string;
  taskTextHash: string;
  promptFeatureResults: Array<{
    featureId: string;
    detected: boolean;
    evaluated: boolean;
  }>;
  suggestedFeatures?: Array<{
    suggestedId: string;
    behavior: string;
    prompt: string;
  }>;
  extractedAt: Date;
  model?: string;
}

export interface InsightReference {
  insightId: string;
  referencedAt: Date;
  isNew: boolean;
}

export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ReportDocument {
  _id: string;
  requestId: string;
  templateId?: string;
  reporter?: {
    id: string;
    name: string;
    gitHash: string;
    model: string;
    agentId: string;
    agentVersion: string;
  };
  content?: string;
  status: "pending" | "generating" | "completed" | "failed";
  error?: string;
  logs: LogEvent[];
  insightReferences?: InsightReference[];
  createdAt: Date;
  updatedAt?: Date;
}

export type ReportTrigger =
  | { type: "always" }
  | { type: "criteria"; criteriaIds: string[]; match?: "any" | "all" }
  | { type: "taskPrompt"; taskPromptIds: string[] }
  | {
      type: "promptFeature";
      featureIds: string[];
      match?: "any" | "all";
    };

export interface ReportTemplateDocument {
  id: string;
  name: string;
  description?: string;
  userPrompt: string;
  systemPrompt?: {
    mode: "append" | "override";
    content: string;
  };
  trigger?: ReportTrigger;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface InsightDocument {
  _id: string;
  title: string;
  description: string;
  category?: string;
  tags?: string[];
  upvotes: number;
  downvotes: number;
  blocked: boolean;
  referenceCount: number;
  createdBy: "agent" | "user";
  sourceReportId?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface RequestDocument {
  _id: string;
  scenario: { task: string; criteria: string[]; version?: "v1" | "v2" };
  workerType: WorkerType;
  model?: string;
  status:
    | "pending"
    | "processing"
    | "iterating"
    | "completed"
    | "failed"
    | "exhausted";
  result?: string;
  error?: string;
  logs?: LogEvent[];
  maxIterations?: number;
  turns?: Array<{
    iteration: number;
    codingAgentResponse: string;
    judgeFeedback: string;
    snapshotUrl: string;
    passed: boolean;
    timestamp: Date;
    harUrl?: string;
    videoUrls?: string[];
  }>;
  personaInstructions?: string;
  persona?: {
    personality: string;
    experience: string;
    verbosity: string;
    type: string;
  };
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
  taskPromptId?: string;
  mcpServers?: string[];
  skillRevisions?: string[];
  harUrl?: string;
  videoUrls?: string[];
  setupVideoUrls?: string[];
  agentVersion?: string;
  workerVersion?: string;
  submissionId?: string;
}

export interface AgentVersion {
  agentVersion: string;
  workerVersion: string;
  components: Record<string, string>;
  gitCommit: string;
  buildTime: string;
  imageTag: string;
  queueName: string;
  status: "active" | "retired";
  createdAt: Date;
}

export interface CodingAgentDocument {
  _id: string;
  name: string;
  description?: string;
  supportedModels: string[];
  defaultModel?: string;
  versions?: AgentVersion[];
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface ModelDocument {
  _id: string;
  modelId: string;
  provider: string;
  agentId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  disappearedAt?: Date;
  providerAvailableFrom?: Date;
  providerEndOfLife?: Date;
  metadata?: Record<string, unknown>;
}

export interface McpServerDocument {
  _id: string;
  name: string;
  type: "sse" | "http";
  url: string;
  headers?: Array<{ name: string; value: string }>;
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export interface FeatureFlagDocument {
  key: string;
  label: string;
  enabled: boolean;
  updatedAt: Date;
}

export const VALID_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot"
] as const;
export type WorkerType = (typeof VALID_WORKERS)[number];

// ─── RouteContext ────────────────────────────────────────────────────────────

/**
 * Dependency-injection context passed to route registration functions.
 * Contains all DB collections, services, and infrastructure the handlers need.
 */
export interface RouteContext {
  // Express + OpenAPI
  app: Express;
  registry: OpenAPIRegistry;

  // MongoDB
  db: Db;
  requestCollection: Collection<RequestDocument>;
  criteriaCollection: Collection<CriteriaDocument>;
  promptFeatureCollection: Collection<PromptFeatureDocument>;
  promptFeatureExtractionCollection: Collection<PromptFeatureExtractionDocument>;
  reportCollection: Collection<ReportDocument>;
  reportTemplateCollection: Collection<ReportTemplateDocument>;
  agentCollection: Collection<CodingAgentDocument>;
  modelCollection: Collection<ModelDocument>;
  mcpServerCollection: Collection<McpServerDocument>;
  insightsCollection: Collection<InsightDocument>;
  taskPromptCollection: Collection<TaskPromptDocument>;
  featureFlagCollection: Collection<FeatureFlagDocument>;
  skillCollection: Collection<SkillDocument>;
  skillRevisionCollection: Collection<SkillRevisionDocument>;

  // Services
  taskPromptStore: TaskPromptStore;
  skillRevisionStore: SkillRevisionStore;
  skillResolver: SkillResolver;

  // Queue
  queueClients: Map<WorkerType, QueueClient>;
  reportQueueClient: QueueClient;
  getOrCreateQueueClient: (queueName: string) => QueueClient;

  // Config
  validWorkers: readonly string[];
  blobServiceClient?: BlobServiceClient;
}
