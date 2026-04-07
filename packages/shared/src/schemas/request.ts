// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ScenarioSchema, PersonaSchema } from "./scenario.js";

extendZodWithOpenApi(z);

export const TokenUsageSchema = z
  .object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  })
  .openapi("TokenUsage");

export const LogEventSchema = z
  .object({
    timestamp: z.string(),
    level: z.enum(["info", "warn", "error", "debug"]),
    source: z.string().optional(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("LogEvent");

export const CriterionResultSchema = z
  .object({
    criterionId: z.string(),
    passed: z.boolean(),
    feedback: z.string(),
    evaluated: z.boolean(),
  })
  .openapi("CriterionResult");

export const ConversationTurnSchema = z
  .object({
    iteration: z.number(),
    codingAgentResponse: z.string(),
    judgeFeedback: z.string(),
    snapshotUrl: z.string(),
    passed: z.boolean(),
    timestamp: z.coerce.date(),
    criteriaResults: z.array(CriterionResultSchema).optional(),
    harUrl: z.string().optional(),
    videoUrls: z.array(z.string()).optional(),
    tokenUsage: TokenUsageSchema.optional(),
    startedAt: z.coerce.date().optional(),
    durationMs: z.number().optional(),
    toolCalls: z.array(z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()),
      response: z.string().optional(),
      timestamp: z.string().optional(),
    })).optional(),
    rawChatUrl: z.string().optional(),
    rawChatFormat: z.string().optional(),
  })
  .openapi("ConversationTurn");

export const RequestStatusSchema = z.enum([
  "pending",
  "processing",
  "done",
]);

export const RequestOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "finished",
]);

export const VALID_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot"
] as const;

export const WorkerTypeSchema = z.enum(VALID_WORKERS);

export const CreateRequestInputSchema = z
  .object({
    scenario: ScenarioSchema,
    model: z.string().optional(),
    maxIterations: z.number().optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
  })
  .openapi("CreateRequestInput");

export const RequestResponseSchema = z
  .object({
    _id: z.string(),
    scenario: ScenarioSchema,
    workerType: z.string(),
    model: z.string().optional(),
    status: RequestStatusSchema,
    outcome: RequestOutcomeSchema.optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    logs: z.array(LogEventSchema).optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    maxIterations: z.number().optional(),
    turns: z.array(ConversationTurnSchema).optional(),
    personaInstructions: z.string().optional(),
    persona: PersonaSchema.optional(),
    deletedAt: z.coerce.date().optional(),
    taskPromptId: z.string().optional(),
    mcpServers: z.array(z.string()).optional(),
    skillRevisions: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
    workerVersion: z.string().optional(),
    harUrl: z.string().optional(),
    videoUrls: z.array(z.string()).optional(),
    setupVideoUrls: z.array(z.string()).optional(),
    tokenUsage: TokenUsageSchema.optional(),
    submissionId: z.string().optional(),
    rawChatUrl: z.string().optional(),
    rawChatFormat: z.string().optional(),
  })
  .openapi("RequestResponse");

export const ListRequestsQuerySchema = z
  .object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    status: RequestStatusSchema.optional(),
    outcome: RequestOutcomeSchema.optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .openapi("ListRequestsQuery");

export const BulkResubmitInputSchema = z
  .object({
    ids: z.array(z.string()).min(1),
    count: z.number().int().min(1).max(10).optional().default(1),
    overrides: z
      .object({
        workerType: z.string().optional(),
        model: z.string().nullable().optional(),
        maxIterations: z.number().nullable().optional(),
        mcpServers: z.array(z.string()).nullable().optional(),
        skillRevisions: z.array(z.string()).nullable().optional(),
        extensions: z.array(z.string()).nullable().optional(),
      })
      .optional(),
  })
  .openapi("BulkResubmitInput");
