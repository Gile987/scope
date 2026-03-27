// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { z } from "zod";
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
  // Zod response schemas → inferred types replace hand-written interfaces
  CriteriaResponseSchema,
  PromptFeatureResponseSchema,
  PromptFeatureExtractionResponseSchema,
  InsightReferenceSchema,
  LogEventSchema,
  ReportResponseSchema,
  InsightResponseSchema,
  AgentVersionSchema,
  AgentResponseSchema,
  ModelResponseSchema,
  McpServerResponseSchema,
  FeatureFlagResponseSchema,
} from "shared";

// ─── Document types (inferred from Zod schemas) ─────────────────────────────

export type CriteriaDocument = z.infer<typeof CriteriaResponseSchema>;
export type PromptFeatureDocument = z.infer<typeof PromptFeatureResponseSchema>;
export type PromptFeatureExtractionDocument = z.infer<typeof PromptFeatureExtractionResponseSchema>;
export type InsightReference = z.infer<typeof InsightReferenceSchema>;
export type LogEvent = z.infer<typeof LogEventSchema>;
export type ReportDocument = z.infer<typeof ReportResponseSchema>;
export type InsightDocument = z.infer<typeof InsightResponseSchema>;
export type AgentVersion = z.infer<typeof AgentVersionSchema>;
export type CodingAgentDocument = z.infer<typeof AgentResponseSchema>;
export type ModelDocument = z.infer<typeof ModelResponseSchema>;
export type McpServerDocument = z.infer<typeof McpServerResponseSchema>;
export type FeatureFlagDocument = z.infer<typeof FeatureFlagResponseSchema>;

// ─── Types not yet migrated to z.infer<> (schema mismatches to resolve) ──────
// RequestDocument: schema turns[] has extra fields (criteriaResults, tokenUsage, etc.)
// ReportTemplateDocument: schema has both _id and id, interface only has id
// These will be migrated once the Request and ReportTemplate route groups move.

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
