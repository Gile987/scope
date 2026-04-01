// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
import dotenv from "dotenv";
import multer from "multer";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";
import { createHash } from "crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { pack as tarPack } from "tar-stream";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { isLlmAvailable, generateCriteriaPrompt } from "./llm.js";
import {
  isLlmAvailable as isPromptFeatureLlmAvailable,
  generatePromptFeaturePrompt,
  extractPromptFeatures,
} from "./prompt-feature-llm.js";
import {
  isTaskPromptLlmAvailable,
  generateTaskPrompt,
} from "./task-prompt-llm.js";
import { computeAnalysis, AnalysisResponse, AnalyzableRun } from "./analysis.js";
import { computeMdp, parseStateKey, type MdpAnalyzableRun } from "./criteria-mdp.js";
import { blobNameFromSnapshotsUrl, rewriteHarUrlsForArchive, detectBundledHarFiles, uploadBundledHarFiles, detectBundledChatFiles, uploadBundledChatFiles } from "./archive-har.js";
import { TaskPromptStore, computeTaskPromptId, type TaskPromptDocument, SkillRevisionStore, SkillResolver, type SkillDocument, type SkillRevisionDocument, type SkillSearchResult, resolveAgentVersion } from "shared";
import { evaluateTrigger, REPORT_SYSTEM_PROMPT } from "shared";
import {
  CreateCriteriaInputSchema,
  UpdateCriteriaInputSchema,
  CriteriaResponseSchema,
  CriteriaGraphSchema,
  ModelResponseSchema,
  ListModelsQuerySchema,
  McpServerResponseSchema,
  UpdateMcpServerInputSchema,
  McpTransportTypeSchema,
  McpServerHeaderSchema,
  FeatureFlagResponseSchema,
  UpdateFeatureFlagInputSchema,
  AgentResponseSchema,
  AgentVersionSchema,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
  RegisterAgentVersionInputSchema,
  PatchAgentVersionInputSchema,
  CreateReportTemplateInputSchema,
  UpdateReportTemplateInputSchema,
  ReportTemplateResponseSchema,
  InsightResponseSchema,
  CreateInsightInputSchema,
  UpdateInsightInputSchema,
  ReportResponseSchema,
  CreateReportInputSchema,
  BulkCreateReportsInputSchema,
  BulkReportStatusInputSchema,
  TriggerReportsInputSchema,
  BulkTriggerReportsInputSchema,
  CreatePromptFeatureInputSchema,
  UpdatePromptFeatureInputSchema,
  PromptFeatureResponseSchema,
  PromptFeatureResultSchema,
  SuggestedPromptFeatureSchema,
  CreateTaskPromptInputSchema,
  TaskPromptResponseSchema,
  PatchTaskPromptFeatureInputSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
  SkillSearchResultSchema,
  CreateSkillInputSchema,
  RequestResponseSchema,
  CreateRequestInputSchema,
  ListRequestsQuerySchema,
  BulkResubmitInputSchema,
} from "shared";
import { checkMigrations } from "db-migrations/check-migrations";
import { generateOpenAPIDocument, registry } from "./openapi/index.js";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { apiRoute } from "./openapi/api-route.js";
import { VALID_WORKERS } from "./route-context.js";
import type {
  CriteriaDocument,
  PromptFeatureDocument,
  PromptFeatureExtractionDocument,
  InsightReference,
  LogEvent,
  ReportDocument,
  ReportTrigger,
  ReportTemplateDocument,
  InsightDocument,
  RequestDocument,
  AgentVersion,
  CodingAgentDocument,
  ModelDocument,
  McpServerDocument,
  FeatureFlagDocument,
  WorkerType,
} from "./route-context.js";

const require = createRequire(import.meta.url);
const Redis = require("ioredis");

dotenv.config();

const app: Express = express();
app.use(cors());
app.use(express.json());

// Multer configuration for file uploads (stored in temp directory)
const upload = multer({ dest: tmpdir() });

// Configuration from environment
// K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret
const mongoUri = process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27000";
const mongoDatabase = process.env.MONGO_DATABASE || "requests-db";
const mongoCollection = process.env.MONGO_COLLECTION || "requests";
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString = process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const queueWorker1 = process.env.AZURE_STORAGE_QUEUE_WORKER_1 || "queue-coder-acp-claude-code";
const queueWorker2 = process.env.AZURE_STORAGE_QUEUE_WORKER_2 || "queue-coder-acp-copilot";
const queueReport = process.env.AZURE_STORAGE_QUEUE_REPORT || "report-queue";
const redisHost = process.env.REDIS_HOST || "";
const redisPort = parseInt(process.env.REDIS_PORT || "6300", 10);
const redisPassword = process.env.REDIS_PASSWORD || "";
const port = parseInt(process.env.PORT || "3000", 10);

// Version information (injected at build time)
const GIT_COMMIT = process.env.GIT_COMMIT || "development";
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();
const SCOPE_ENVIRONMENT = process.env.SCOPE_ENVIRONMENT || "production";

// MongoDB clients
let mongoClient: MongoClient;
let db: Db;
let collection: Collection<RequestDocument>;
let criteriaCollection: Collection<CriteriaDocument>;
let promptFeatureCollection: Collection<PromptFeatureDocument>;
let promptFeatureExtractionCollection: Collection<PromptFeatureExtractionDocument>;
let reportCollection: Collection<ReportDocument>;
let agentCollection: Collection<CodingAgentDocument>;
let modelCollection: Collection<ModelDocument>;
let mcpServerCollection: Collection<McpServerDocument>;
let insightsCollection: Collection<InsightDocument>;
let taskPromptCollection: Collection<TaskPromptDocument>;
let taskPromptStore: TaskPromptStore;
let featureFlagCollection: Collection<FeatureFlagDocument>;
let reportTemplateCollection: Collection<ReportTemplateDocument>;
let skillCollection: Collection<SkillDocument>;
let skillRevisionCollection: Collection<SkillRevisionDocument>;
let skillRevisionStore: SkillRevisionStore;
let skillResolver: SkillResolver;
const queueClients: Map<WorkerType, QueueClient> = new Map();
const dynamicQueueClients: Map<string, QueueClient> = new Map();
let reportQueueClient: QueueClient;

// Queue message interface
interface QueueMessage {
  requestId: string;
}

// SSE client management for connection pooling
type SSEClient = {
  res: Response;
  cleanup: () => void;
  onActivity?: () => void;
};
const sseClients: Map<string, Set<SSEClient>> = new Map();
let sharedSubscriber: InstanceType<typeof Redis> | null = null;
const subscribedChannels: Set<string> = new Set();

// Determine if we should use TLS (Azure Redis uses port 6380 with TLS)
const useRedisTls = redisPassword && redisPort !== 6379;

// Track if Redis error has been logged to avoid spam
let redisErrorLogged = false;

function getOrCreateSubscriber(): InstanceType<typeof Redis> {
  if (!sharedSubscriber && redisHost) {
    sharedSubscriber = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      ...(useRedisTls ? { tls: { servername: redisHost } } : {}),
      // Limit reconnection attempts to avoid log spam
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts
        }
        return Math.min(times * 1000, 3000);
      },
    });

    sharedSubscriber.on("message", (channel: string, message: string) => {
      const requestId = channel.replace("logs:", "");
      const clients = sseClients.get(requestId);
      if (clients) {
        for (const client of clients) {
          client.res.write(`data: ${message}\n\n`);
          client.onActivity?.();

          // Check for completion
          try {
            const logEvent = JSON.parse(message) as LogEvent;
            if (logEvent.data?.final === true) {
              client.res.write(`event: done\ndata: {"status":"completed"}\n\n`);
              client.cleanup();
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    });

    sharedSubscriber.on("error", (err: Error) => {
      // Only log once to avoid spam
      if (!redisErrorLogged) {
        console.error("Shared Redis subscriber error:", err.message);
        redisErrorLogged = true;
      }
    });

    sharedSubscriber.on("connect", () => {
      redisErrorLogged = false; // Reset on successful connect
      console.log("Redis subscriber connected");
    });

    console.log(`Initialized shared Redis subscriber (TLS: ${useRedisTls})`);
  }
  return sharedSubscriber!;
}

async function subscribeClient(requestId: string, client: SSEClient): Promise<void> {
  const channelName = `logs:${requestId}`;
  
  // Add client to the set
  if (!sseClients.has(requestId)) {
    sseClients.set(requestId, new Set());
  }
  sseClients.get(requestId)!.add(client);

  // Subscribe to channel if not already subscribed
  if (!subscribedChannels.has(channelName)) {
    const subscriber = getOrCreateSubscriber();
    await subscriber.subscribe(channelName);
    subscribedChannels.add(channelName);
    console.log(`Subscribed to channel: ${channelName}`);
  }
}

function unsubscribeClient(requestId: string, client: SSEClient): void {
  const clients = sseClients.get(requestId);
  if (clients) {
    clients.delete(client);
    
    // If no more clients for this request, unsubscribe from channel
    if (clients.size === 0) {
      sseClients.delete(requestId);
      const channelName = `logs:${requestId}`;
      if (sharedSubscriber && subscribedChannels.has(channelName)) {
        sharedSubscriber.unsubscribe(channelName);
        subscribedChannels.delete(channelName);
        console.log(`Unsubscribed from channel: ${channelName}`);
      }
    }
  }
}

async function initializeClients(): Promise<void> {
  // Connect to MongoDB
  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db(mongoDatabase);
  collection = db.collection<RequestDocument>(mongoCollection);
  criteriaCollection = db.collection<CriteriaDocument>("criteria");
  promptFeatureCollection = db.collection<PromptFeatureDocument>("prompt-features");
  promptFeatureExtractionCollection = db.collection<PromptFeatureExtractionDocument>("prompt-feature-extractions");
  reportCollection = db.collection<ReportDocument>("reports");
  agentCollection = db.collection<CodingAgentDocument>("agents");
  modelCollection = db.collection<ModelDocument>("models");
  mcpServerCollection = db.collection<McpServerDocument>("mcp-servers");
  insightsCollection = db.collection<InsightDocument>("insights");
  taskPromptCollection = db.collection<TaskPromptDocument>("task-prompts");
  taskPromptStore = new TaskPromptStore(taskPromptCollection);
  featureFlagCollection = db.collection<FeatureFlagDocument>("feature-flags");
  reportTemplateCollection = db.collection<ReportTemplateDocument>("report-templates");
  skillCollection = db.collection<SkillDocument>("skills");
  skillRevisionCollection = db.collection<SkillRevisionDocument>("skill-revisions");
  skillRevisionStore = new SkillRevisionStore(skillRevisionCollection);
  skillResolver = new SkillResolver({
    githubToken: process.env.GITHUB_TOKEN,
  });

  // Note: Collection indexes are managed by db-migrations (see 002-create-indexes.ts).
  // Run `pnpm migrate:up` to apply pending migrations.

  const criteriaCount = await criteriaCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Criteria collection has ${criteriaCount} documents`);

  const promptFeatureCount = await promptFeatureCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Prompt features collection has ${promptFeatureCount} documents`);

  const agentCount = await agentCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Agents collection has ${agentCount} documents`);

  const modelCount = await modelCollection.countDocuments();
  console.log(`Models collection has ${modelCount} documents`);

  const mcpServerCount = await mcpServerCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`MCP servers collection has ${mcpServerCount} documents`);

  const skillCount = await skillCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Skills collection has ${skillCount} documents`);

  // Seed default feature flags (upsert — won't overwrite existing enabled state)
  const defaultFlags: Array<{ key: string; label: string }> = [
    { key: "mcp", label: "MCP Servers" },
    { key: "models", label: "Models" },
    { key: "agents", label: "Agents" },
    { key: "tokens", label: "Tokens" },
  ];
  for (const flag of defaultFlags) {
    await featureFlagCollection.updateOne(
      { key: flag.key },
      { $setOnInsert: { key: flag.key, label: flag.label, enabled: true, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  const featureFlagCount = await featureFlagCollection.countDocuments();
  console.log(`Feature flags collection has ${featureFlagCount} documents`);

  const insightCount = await insightsCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Insights collection has ${insightCount} documents`);

  // Seed default agents (upsert — always updates name and modelProvider, preserves existing models)
  const defaultAgents: Array<{ _id: string; name: string; modelProvider?: string }> = [
    { _id: "coder-acp-claude-code", name: "Claude Code (ACP)", modelProvider: "anthropic" },
    { _id: "coder-acp-copilot", name: "Copilot (ACP)", modelProvider: "github-copilot" },
  ];
  for (const agent of defaultAgents) {
    await agentCollection.updateOne(
      { _id: agent._id },
      {
        $set: { name: agent.name, ...(agent.modelProvider ? { modelProvider: agent.modelProvider } : {}) },
        $setOnInsert: { supportedModels: [], createdAt: new Date() },
      },
      { upsert: true }
    );
  }
  console.log(`Ensured ${defaultAgents.length} default agents exist`);
  
  console.log(`Connected to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  // Initialize queue clients
  if (storageConnectionString) {
    // Connection string auth (local Azurite or Azure with connection string)
    queueClients.set("coder-acp-claude-code", new QueueClient(storageConnectionString, queueWorker1));
    queueClients.set("coder-acp-copilot", new QueueClient(storageConnectionString, queueWorker2));
    reportQueueClient = new QueueClient(storageConnectionString, queueReport);
  } else {
    // Azure with DefaultAzureCredential
    const credential = new DefaultAzureCredential();
    const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
    queueClients.set("coder-acp-claude-code", new QueueClient(`${queueUrl}/${queueWorker1}`, credential));
    queueClients.set("coder-acp-copilot", new QueueClient(`${queueUrl}/${queueWorker2}`, credential));
    reportQueueClient = new QueueClient(`${queueUrl}/${queueReport}`, credential);
  }

  // Ensure queues exist (creates them in Azurite on first run)
  for (const [name, client] of queueClients) {
    await client.createIfNotExists();
    console.log(`Ensured queue exists: ${name}`);
  }
  await reportQueueClient.createIfNotExists();
  console.log(`Ensured queue exists: ${queueReport}`);

  console.log(`Initialized Queue clients for workers: ${Array.from(queueClients.keys()).join(", ")}, report`);
}

// Get or create a QueueClient for a dynamically resolved queue name
function getOrCreateQueueClient(queueName: string): QueueClient {
  const existing = dynamicQueueClients.get(queueName);
  if (existing) return existing;
  let client: QueueClient;
  if (storageConnectionString) {
    client = new QueueClient(storageConnectionString, queueName);
  } else {
    const credential = new DefaultAzureCredential();
    const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
    client = new QueueClient(`${queueUrl}/${queueName}`, credential);
  }
  dynamicQueueClients.set(queueName, client);
  return client;
}

// --- OpenAPI documentation (lazy — Swagger UI mounted in main() after all routes register) ---

// Health check endpoint (liveness probe — always returns 200)
apiRoute(app, registry, {
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Liveness probe",
  response: z.object({ status: z.string(), version: z.string() }),
  handler: async (_req, res) => {
    res.json({ status: "healthy", version: GIT_COMMIT });
  },
});

// Readiness probe — returns 200 only when all required DB migrations have
// been applied. Kubernetes will withhold traffic until this returns 200.
apiRoute(app, registry, {
  method: "get",
  path: "/ready",
  tags: ["Health"],
  summary: "Readiness probe",
  response: z.object({ status: z.string(), migrations: z.any() }),
  errorResponses: {
    503: { description: "Service is not ready" },
  },
  handler: async (_req, res) => {
    try {
      const result = await checkMigrations(db);
      if (result.ready) {
        res.json({ status: "ready", migrations: result });
      } else {
        res.status(503).json({ status: "not-ready", migrations: result });
      }
    } catch (err: any) {
      res.status(503).json({
        status: "not-ready",
        error: err.message ?? String(err),
      });
    }
  },
});

// About endpoint
apiRoute(app, registry, {
  method: "get",
  path: "/about",
  tags: ["System"],
  summary: "API metadata",
  response: z.object({
    name: z.string(),
    version: z.string(),
    buildTime: z.string(),
    environment: z.string(),
    description: z.string(),
    workers: z.array(z.string()),
  }),
  handler: async (_req, res) => {
    res.json({
      name: "Multi-Worker API (MongoDB)",
      version: GIT_COMMIT,
      buildTime: BUILD_TIME,
      environment: SCOPE_ENVIRONMENT,
      description: "API that routes requests to multiple workers via separate queues",
      workers: VALID_WORKERS,
    });
  },
});

// Version endpoint
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/version",
  tags: ["System"],
  summary: "Version info",
  response: z.object({
    commit: z.string(),
    buildTime: z.string(),
    environment: z.string(),
  }),
  handler: async (_req, res) => {
    res.json({
      commit: GIT_COMMIT,
      buildTime: BUILD_TIME,
      environment: SCOPE_ENVIRONMENT,
    });
  },
});

// Submit a request
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "Submit request(s)",
  body: CreateRequestInputSchema.extend({
    count: z.number().min(1).max(10).default(1),
    promptFeatureExtractionId: z.string().optional(),
    skills: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
  }),
  response: z.union([RequestResponseSchema, z.array(RequestResponseSchema)]),
  successStatus: 201,
  handler: async (req, res) => {
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions, count = 1, promptFeatureExtractionId, model: requestedModel, mcpServers: mcpServerSlugs, skills: skillSlugs, agentVersion: requestedAgentVersion } = req.body;
    const worker = req.query.worker as string;

    if (!scenarioObj || typeof scenarioObj !== "object" || !scenarioObj.task || typeof scenarioObj.task !== "string") {
      res.status(400).json({ error: "scenario.task is required and must be a string" });
      return;
    }

    if (!worker) {
      res.status(400).json({ 
        error: "Worker query parameter is required",
        validWorkers: VALID_WORKERS,
        example: "/api/v1/requests?worker=worker-1"
      });
      return;
    }

    if (!VALID_WORKERS.includes(worker as WorkerType)) {
      res.status(400).json({ 
        error: `Invalid worker: ${worker}`,
        validWorkers: VALID_WORKERS
      });
      return;
    }

    // Validate scenario.criteria if provided
    if (scenarioObj.criteria !== undefined) {
      if (!Array.isArray(scenarioObj.criteria) || !scenarioObj.criteria.every((c: unknown) => typeof c === "string")) {
        res.status(400).json({ error: "scenario.criteria must be an array of strings" });
        return;
      }
    }

    // At least one criterion is required
    if (!scenarioObj.criteria || !Array.isArray(scenarioObj.criteria) || scenarioObj.criteria.length === 0) {
      res.status(400).json({ error: "At least one criterion is required in scenario.criteria" });
      return;
    }

    // Validate maxIterations if provided
    if (maxIterations !== undefined) {
      if (typeof maxIterations !== "number" || maxIterations < 1 || maxIterations > 50) {
        res.status(400).json({ error: "maxIterations must be a number between 1 and 50" });
        return;
      }
    }

    // Validate count if provided
    if (typeof count !== "number" || count < 1 || count > 10) {
      res.status(400).json({ error: "count must be a number between 1 and 10" });
      return;
    }

    const workerType = worker as WorkerType;

    // Resolve model: validate against agent's supportedModels if available
    let model: string | undefined = requestedModel;
    const agentDoc = await agentCollection.findOne({ _id: workerType, deletedAt: { $exists: false } });
    if (agentDoc && agentDoc.supportedModels.length > 0) {
      if (model && !agentDoc.supportedModels.includes(model)) {
        res.status(400).json({
          error: `Invalid model "${model}" for agent "${workerType}"`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
      if (!model && agentDoc.defaultModel) {
        model = agentDoc.defaultModel;
      }
      if (!model) {
        res.status(400).json({
          error: `model is required for agent "${workerType}". Select one of supportedModels or set a defaultModel on the agent.`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
    }

    // Resolve agent version: explicit selection or latest active
    let resolvedAgentVersion: string | undefined;
    let versionQueueName: string | undefined;
    if (agentDoc) {
      const versionResult = resolveAgentVersion(agentDoc.versions, requestedAgentVersion);
      if ("error" in versionResult) {
        res.status(400).json({
          error: `${versionResult.error} for agent "${workerType}"`,
          activeVersions: versionResult.activeVersions,
        });
        return;
      }
      resolvedAgentVersion = versionResult.agentVersion;
      versionQueueName = versionResult.queueName;
    }

    // Validate MCP server slugs if provided
    let validatedMcpServers: string[] | undefined;
    if (mcpServerSlugs !== undefined) {
      if (!Array.isArray(mcpServerSlugs) || !mcpServerSlugs.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "mcpServers must be an array of strings (MCP server slugs)" });
        return;
      }
      if (mcpServerSlugs.length > 0) {
        const existingServers = await mcpServerCollection
          .find({ _id: { $in: mcpServerSlugs }, deletedAt: { $exists: false } })
          .toArray();
        const existingSlugs = new Set(existingServers.map((s: McpServerDocument) => s._id));
        const missingSlugs = mcpServerSlugs.filter((slug: string) => !existingSlugs.has(slug));
        if (missingSlugs.length > 0) {
          res.status(400).json({ error: `MCP server(s) not found: ${missingSlugs.join(", ")}` });
          return;
        }
        validatedMcpServers = mcpServerSlugs;
      }
    }

    // Validate and resolve skill slugs if provided
    let resolvedSkillRevisions: string[] | undefined;
    if (skillSlugs !== undefined) {
      if (!Array.isArray(skillSlugs) || !skillSlugs.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "skills must be an array of strings (skill slugs)" });
        return;
      }
      if (skillSlugs.length > 0) {
        // Validate skill slugs exist in our DB
        const existingSkills = await skillCollection
          .find({ _id: { $in: skillSlugs }, deletedAt: { $exists: false } })
          .toArray();
        const existingSkillSlugs = new Set(existingSkills.map((s: SkillDocument) => s._id));
        const missingSkillSlugs = skillSlugs.filter((slug: string) => !existingSkillSlugs.has(slug));
        if (missingSkillSlugs.length > 0) {
          res.status(400).json({ error: `Skill(s) not found: ${missingSkillSlugs.join(", ")}` });
          return;
        }

        // Resolve each skill to a SkillRevisionDocument
        const uploadArchive = async (archiveName: string, data: Buffer): Promise<string> => {
          if (!storageConnectionString && !storageAccountName) {
            throw new Error("Blob storage not configured — cannot store skill archives");
          }
          let blobServiceClient: BlobServiceClient;
          if (storageConnectionString) {
            blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
          } else {
            const credential = new DefaultAzureCredential();
            blobServiceClient = new BlobServiceClient(
              `https://${storageAccountName}.blob.core.windows.net`,
              credential
            );
          }
          const containerClient = blobServiceClient.getContainerClient("skill-archives");
          await containerClient.createIfNotExists();
          const blockBlobClient = containerClient.getBlockBlobClient(archiveName);
          await blockBlobClient.upload(data, data.length, {
            blobHTTPHeaders: { blobContentType: "application/gzip" },
          });
          return blockBlobClient.url;
        };

        const revisionRefs: string[] = [];
        for (const skill of existingSkills) {
          try {
            const revision = await skillResolver.resolve(
              skill.source,
              skill.skillName,
              skillRevisionStore,
              uploadArchive
            );
            revisionRefs.push(revision.ref);
          } catch (resolveError) {
            console.error(`Failed to resolve skill "${skill._id}":`, resolveError);
            res.status(422).json({
              error: `Failed to resolve skill "${skill._id}": ${resolveError instanceof Error ? resolveError.message : String(resolveError)}`,
            });
            return;
          }
        }
        resolvedSkillRevisions = revisionRefs;
      }
    }

    // Normalize scenario: ensure criteria is always an array, preserve version
    const scenario: RequestDocument['scenario'] = {
      task: scenarioObj.task as string,
      criteria: Array.isArray(scenarioObj.criteria) ? scenarioObj.criteria as string[] : [],
      ...(scenarioObj.version === 'v1' || scenarioObj.version === 'v2' ? { version: scenarioObj.version } : {}),
    };

    const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";
    // Use version-specific queue if resolved, otherwise fall back to static worker queue
    const queueClient = versionQueueName
      ? getOrCreateQueueClient(versionQueueName)
      : queueClients.get(workerType)!;

    // Ensure a TaskPrompt entity exists for this task text (idempotent)
    const taskPrompt = await taskPromptStore.findOrCreate(scenario.task);
    const taskPromptId = taskPrompt._id;

    // Generate a submission ID to group all runs from this request
    const submissionId = uuidv4();

    // Handle multiple runs (count > 1)
    if (count > 1) {
      const newIds: string[] = [];
      const newDocs: RequestDocument[] = [];
      const queueMessages: string[] = [];

      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        newIds.push(requestId);

        const requestDoc: RequestDocument = {
          _id: requestId,
          scenario,
          workerType,
          taskPromptId,
          status: "pending",
          createdAt: new Date(),
          ...(model ? { model } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          ...(personaInstructions ? { personaInstructions } : {}),
          ...(personaObj ? { persona: personaObj } : {}),
          ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
          ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
          ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
          submissionId,
        };
        newDocs.push(requestDoc);

        const queueMessage: QueueMessage = { requestId };
        const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
        queueMessages.push(messageContent);
      }

      // Bulk insert all documents
      await collection.insertMany(newDocs);

      // Queue all messages
      for (const message of queueMessages) {
        await queueClient.sendMessage(message);
      }

      console.log(`Created ${count} ${mode} requests for ${workerType} and queued for processing`);

      res.status(201).json({
        ids: newIds,
        count,
        submissionId,
        workerType,
        taskPromptId,
        ...(model ? { model } : {}),
        ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
        status: "pending",
        mode,
        message: `${count} requests submitted successfully`,
        scenario,
        ...(maxIterations ? { maxIterations } : {}),
      });
      return;
    }

    // Single run (count === 1) - original behavior
    const requestId = uuidv4();

    // Create request document
    const requestDoc: RequestDocument = {
      _id: requestId,
      scenario,
      workerType,
      taskPromptId,
      status: "pending",
      createdAt: new Date(),
      ...(model ? { model } : {}),
      ...(maxIterations ? { maxIterations } : {}),
      ...(personaInstructions ? { personaInstructions } : {}),
      ...(personaObj ? { persona: personaObj } : {}),
      ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
      ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
      ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      submissionId,
    };

    // Store in MongoDB
    await collection.insertOne(requestDoc);

    // Queue the request for the appropriate worker
    const queueMessage: QueueMessage = { requestId };
    const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
    await queueClient.sendMessage(messageContent);

    console.log(`Created ${mode} request ${requestId} for ${workerType} and queued for processing`);

    res.status(201).json({
      id: requestId,
      submissionId,
      workerType,
      ...(model ? { model } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      status: requestDoc.status,
      mode,
      message: "Request submitted successfully",
      scenario,
      ...(maxIterations ? { maxIterations } : {}),
    });
  },
});

// Get request status
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Get request",
  params: z.object({ id: z.string() }),
  response: RequestResponseSchema,
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const resource = await collection.findOne({ _id: id });

    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Map _id back to id for API response
    res.json({ ...resource, id: resource._id });
  },
});

// Stream logs for a request via SSE (with connection pooling)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/logs",
  tags: ["Requests"],
  summary: "Stream request logs (SSE)",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;
    const fromStart = req.query.fromStart === "true";

    // Verify request exists
    const resource = await collection.findOne({ _id: id });

    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // If fromStart=true, send existing logs from MongoDB first
    if (fromStart && resource.logs && resource.logs.length > 0) {
      for (const log of resource.logs) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    }

    // If request already completed/failed/exhausted, send final event and close
    if (resource.status === "completed" || resource.status === "failed" || resource.status === "exhausted") {
      // For completed multi-turn requests, send turns summary
      if (resource.turns && resource.turns.length > 0) {
        res.write(`data: ${JSON.stringify({ type: "turns_summary", turns: resource.turns.length, passed: resource.status === "completed" })}\n\n`);
      }
      res.write(`event: done\ndata: {"status":"${resource.status}"}\n\n`);
      res.end();
      return;
    }

    // Use connection pooling - single shared subscriber
    let cleaned = false;
    let changeStream: ReturnType<typeof collection.watch> | null = null;
    let redisSubscribed = false;

    // Inactivity timeout — resets every time a log message is forwarded
    const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of silence
    let inactivityTimer: ReturnType<typeof setTimeout>;

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        res.write(`event: timeout\ndata: {"message":"Stream timeout after 5 minutes of inactivity"}\n\n`);
        client.cleanup();
      }, INACTIVITY_TIMEOUT_MS);
    };

    // SSE heartbeat every 30s to prevent proxy/LB disconnects
    const heartbeat = setInterval(() => {
      if (!cleaned) {
        res.write(`:\n\n`); // SSE comment — ignored by EventSource clients
      }
    }, 30_000);

    const client: SSEClient = {
      res,
      onActivity: resetInactivityTimer,
      cleanup: () => {
        if (!cleaned) {
          cleaned = true;
          clearTimeout(inactivityTimer);
          clearInterval(heartbeat);
          if (changeStream) {
            changeStream.close().catch(err => console.error("Error closing change stream:", err));
          }
          if (redisSubscribed) {
            unsubscribeClient(id, client);
          }
          res.end();
        }
      },
    };

    // Start the inactivity timer
    resetInactivityTimer();

    // Try Redis subscription if configured (non-blocking - fallback to Change Streams if unavailable)
    if (redisHost) {
      try {
        await subscribeClient(id, client);
        redisSubscribed = true;
      } catch (err) {
        console.error(`Redis subscription failed for ${id}, using Change Streams only:`, err);
      }
    }

    // Use MongoDB Change Streams as fallback (or primary if Redis unavailable)
    try {
      changeStream = collection.watch(
        [{ $match: { "documentKey._id": id, operationType: "update" } }],
        { fullDocument: "updateLookup" }
      );
      
      changeStream.on("change", (change) => {
        if (change.operationType === "update" && change.fullDocument) {
          const doc = change.fullDocument;
          if (doc.status === "completed" || doc.status === "failed" || doc.status === "exhausted") {
            res.write(`event: done\ndata: {"status":"${doc.status}"}\n\n`);
            client.cleanup();
          }
        }
      });

      changeStream.on("error", (err) => {
        console.error(`Change stream error for ${id}:`, err);
        // Change stream failed, don't retry - the 5 minute timeout will handle it
      });
    } catch (err) {
      console.error(`Failed to create change stream for ${id}:`, err);
      // Change streams not supported (e.g., some CosmosDB configurations)
    }

    // Cleanup on client disconnect
    req.on("close", () => client.cleanup());
  },
});

// List all requests (excludes soft-deleted by default)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "List requests",
  query: ListRequestsQuerySchema,
  response: z.array(RequestResponseSchema),
  handler: async (req, res) => {
    const workerFilter = req.query.worker as string;
    const taskPromptIdFilter = req.query.taskPromptId as string;
    const criteriaFilter = req.query.criteria as string;
    const submissionIdFilter = req.query.submissionId as string;
    const includeDeleted = req.query.includeDeleted === "true";
    
    const filter: Record<string, unknown> = {};
    if (workerFilter && VALID_WORKERS.includes(workerFilter as WorkerType)) {
      filter.workerType = workerFilter;
    }
    if (taskPromptIdFilter) {
      filter.taskPromptId = taskPromptIdFilter;
    }
    if (submissionIdFilter) {
      // Prefix-based matching: allow filtering by partial submission ID
      filter.submissionId = { $regex: `^${submissionIdFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    }
    if (!includeDeleted) {
      filter.deletedAt = { $exists: false };
    }

    // Filter by MDP criteria state vector (e.g. "has_azure:0|has_cloud:1")
    // Matches runs whose LAST turn contains criteria results matching every
    // criterion in the state vector.
    if (criteriaFilter) {
      const criteriaStates = parseStateKey(criteriaFilter);
      if (criteriaStates.length > 0) {
        filter.$and = criteriaStates.map((cs) => ({
          "turns": {
            $elemMatch: {
              "criteriaResults": {
                $elemMatch: {
                  criterionId: cs.id,
                  passed: cs.passed,
                },
              },
            },
          },
        }));
      }
    }

    const resources = await collection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(resources.map(r => ({ ...r, id: r._id })));
  },
});

// Analysis endpoint - compute pass@k, success@T, and iteration stats
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/analysis",
  tags: ["Requests"],
  summary: "Compute pass@k / success@T metrics",
  query: z.object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    k: z.string().optional(),
  }),
  response: z.object({}).passthrough().describe("Analysis metrics"),
  handler: async (req, res) => {
    // Parse k values from query string (default: 1,2,5)
    const kParam = (req.query.k as string) || "1,2,5";
    const kValues = kParam.split(",").map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v) && v > 0);

    // Parse criteria filter from query string (comma-separated criterion IDs)
    const criteriaParam = req.query.criteria as string | undefined;
    const selectedCriteria = criteriaParam
      ? criteriaParam.split(",").map(c => c.trim()).filter(Boolean)
      : undefined;

    // Fetch all completed/failed runs (exclude pending/processing, exclude deleted)
    const runs = await collection
      .find({
        status: { $in: ["completed", "failed", "exhausted"] },
        deletedAt: { $exists: false },
      })
      .project({
        _id: 1,
        scenario: 1,
        workerType: 1,
        status: 1,
        turns: 1,
      })
      .toArray();

    // Transform to AnalyzableRun format
    const analyzableRuns: AnalyzableRun[] = runs.map(r => ({
      scenario: r.scenario,
      workerType: r.workerType,
      status: r.status,
      turns: r.turns,
    }));

    const analysis: AnalysisResponse = computeAnalysis(analyzableRuns, kValues, selectedCriteria);
    res.json(analysis);
  },
});

// Bulk re-submit requests (create new runs from existing ones)
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/requests/bulk-resubmit",
  tags: ["Requests"],
  summary: "Bulk resubmit requests",
  body: BulkResubmitInputSchema,
  response: z.array(RequestResponseSchema),
  successStatus: 201,
  handler: async (req, res) => {
    const { ids, count, overrides } = req.body;

    // Validate workerType override against known workers
    if (overrides?.workerType && !VALID_WORKERS.includes(overrides.workerType as WorkerType)) {
      res.status(400).json({ error: `Invalid workerType override: ${overrides.workerType}` });
      return;
    }

    // Fetch original runs
    const originalRuns = await collection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } }
    ).toArray();

    const foundIds = new Set(originalRuns.map(r => r._id));
    const notFound = ids.filter(id => !foundIds.has(id));

    const submissionId = uuidv4();
    const newIds: string[] = [];
    const newDocs: RequestDocument[] = [];
    const queueMessages: Array<{ workerType: WorkerType; message: string }> = [];

    for (const original of originalRuns) {
      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        newIds.push(requestId);

        // Resolve effective values: override > original > omit
        const effectiveWorkerType = (overrides?.workerType ?? original.workerType) as WorkerType;
        const effectiveModel = overrides?.model !== undefined ? overrides.model : original.model;
        const effectiveMaxIterations = overrides?.maxIterations !== undefined ? overrides.maxIterations : original.maxIterations;
        const effectiveMcpServers = overrides?.mcpServers !== undefined ? overrides.mcpServers : original.mcpServers;
        const effectiveSkillRevisions = overrides?.skillRevisions !== undefined ? overrides.skillRevisions : original.skillRevisions;

        const newDoc: RequestDocument = {
          _id: requestId,
          scenario: original.scenario,
          workerType: effectiveWorkerType,
          status: "pending",
          createdAt: new Date(),
          ...(effectiveMaxIterations ? { maxIterations: effectiveMaxIterations } : {}),
          ...(original.personaInstructions ? { personaInstructions: original.personaInstructions } : {}),
          ...(original.persona ? { persona: original.persona } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveMcpServers && effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {}),
          ...(effectiveSkillRevisions && effectiveSkillRevisions.length > 0 ? { skillRevisions: effectiveSkillRevisions } : {}),
          submissionId,
        };

        newDocs.push(newDoc);

        const queueMessage: QueueMessage = { requestId };
        const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
        queueMessages.push({ workerType: effectiveWorkerType as WorkerType, message: messageContent });
      }
    }

    // Insert all new documents
    if (newDocs.length > 0) {
      await collection.insertMany(newDocs);
    }

    // Queue all messages
    for (const { workerType, message } of queueMessages) {
      const queueClient = queueClients.get(workerType);
      if (queueClient) {
        await queueClient.sendMessage(message);
      }
    }

    console.log(`Bulk re-submitted ${newIds.length} runs from ${originalRuns.length} originals (count=${count})`);

    res.status(201).json({
      submitted: newIds.length,
      failed: notFound,
      newIds,
      submissionId,
    });
  },
});

// Bulk soft-delete requests
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/requests/bulk",
  tags: ["Requests"],
  summary: "Bulk soft-delete requests",
  body: z.object({ ids: z.array(z.string()) }),
  response: z.object({ deleted: z.number() }),
  handler: async (req, res) => {
    const { ids } = req.body as { ids?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "Request body must include 'ids' array" });
      return;
    }

    // Find which IDs exist and are not already deleted
    const existingDocs = await collection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { projection: { _id: 1 } }
    ).toArray();
    const existingIds = new Set(existingDocs.map(d => d._id));

    // Soft-delete all matching documents
    const result = await collection.updateMany(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    // Determine which IDs were not found or already deleted
    const notFound = ids.filter(id => !existingIds.has(id));

    res.json({
      deleted: result.modifiedCount,
      notFound,
    });
  },
});

// Soft-delete a request
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Soft-delete request",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const result = await collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      const exists = await collection.findOne({ _id: id });
      if (!exists) {
        res.status(404).json({ error: "Request not found" });
      } else {
        res.status(410).json({ error: "Request already deleted" });
      }
      return;
    }

    res.json({ id, deleted: true });
  },
});

// Download a snapshot for a specific iteration
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/snapshots/:iteration",
  tags: ["Requests"],
  summary: "Download iteration snapshot",
  params: z.object({ id: z.string(), iteration: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped snapshot archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id, iteration } = req.params;
    const iterNum = parseInt(iteration, 10);
    if (isNaN(iterNum) || iterNum < 1) {
      res.status(400).json({ error: "Invalid iteration number" });
      return;
    }

    const resource = await collection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const turn = resource.turns?.find(t => t.iteration === iterNum);
    if (!turn?.snapshotUrl) {
      res.status(404).json({ error: `No snapshot for iteration ${iterNum}` });
      return;
    }

    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    // Parse blob name from snapshot URL
    const snapshotUrl = new URL(turn.snapshotUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = snapshotUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid snapshot URL format" });
      return;
    }
    const blobName = snapshotUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download snapshot" });
      return;
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}-iteration-${iterNum}.tar.gz"`);
    if (downloadResponse.contentLength) {
      res.setHeader("Content-Length", downloadResponse.contentLength);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// Download a full run archive (run.yaml + iteration snapshots as .tar.gz entries)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/archive",
  tags: ["Requests"],
  summary: "Download full run archive",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped run archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;

    const resource = await collection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    if (!resource.turns || resource.turns.length === 0) {
      res.status(404).json({ error: "No iterations found for this run" });
      return;
    }

    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }
    const containerClient = blobServiceClient.getContainerClient("snapshots");

    // Set response headers before streaming
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.tar.gz"`);

    // Create streaming tar+gzip pipeline → response
    const pack = tarPack();
    const gzip = createGzip();
    pack.pipe(gzip).pipe(res);

    // Build a copy of the resource with harUrl fields rewritten to relative paths
    const archiveResource = rewriteHarUrlsForArchive(resource);

    // Entry 1: run.yaml — the full run document (with relative HAR paths)
    const yamlContent = yamlStringify(archiveResource, { lineWidth: 120 });
    const yamlBuf = Buffer.from(yamlContent, "utf-8");
    pack.entry({ name: `${id}/run.yaml`, size: yamlBuf.length }, yamlBuf);

    // Entries 2..N: iteration snapshots as-is (.tar.gz blobs)
    for (const turn of resource.turns) {
      if (!turn.snapshotUrl) continue;

      try {
        const blobName = blobNameFromSnapshotsUrl(turn.snapshotUrl);
        if (!blobName) continue;

        const blobClient = containerClient.getBlockBlobClient(blobName);
        const downloadResponse = await blobClient.download();

        if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;

        // Add the snapshot blob as a tar entry, streaming directly from blob storage
        const entry = pack.entry({
          name: `${id}/iteration-${turn.iteration}.tar.gz`,
          size: downloadResponse.contentLength,
        });
        await pipeline(downloadResponse.readableStreamBody, entry);
      } catch (blobError) {
        // Skip snapshots that fail to download (e.g. deleted blobs)
        if (blobError instanceof RestError && (blobError.statusCode === 404 || blobError.code === "ContainerNotFound" || blobError.code === "BlobNotFound")) {
          continue;
        }
        throw blobError;
      }
    }

    // Bundle HAR files into the archive
    const harEntries: Array<{ url: string; entryName: string }> = [];
    for (const turn of resource.turns) {
      if (turn.harUrl) harEntries.push({ url: turn.harUrl, entryName: `${id}/iteration-${turn.iteration}.har` });
    }
    if (resource.harUrl) harEntries.push({ url: resource.harUrl, entryName: `${id}/run.har` });

    for (const { url, entryName } of harEntries) {
      try {
        const blobName = blobNameFromSnapshotsUrl(url);
        if (!blobName) continue;

        const blobClient = containerClient.getBlockBlobClient(blobName);
        const downloadResponse = await blobClient.download();
        if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;

        const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
        await pipeline(downloadResponse.readableStreamBody, entry);
      } catch (blobError) {
        if (blobError instanceof RestError && (blobError.statusCode === 404 || blobError.code === "ContainerNotFound" || blobError.code === "BlobNotFound")) {
          continue;
        }
        throw blobError;
      }
    }

    // Bundle raw chat export files into the archive
    const chatEntries: Array<{ url: string; entryName: string }> = [];
    for (const turn of resource.turns) {
      if (turn.rawChatUrl) chatEntries.push({ url: turn.rawChatUrl, entryName: `${id}/iteration-${turn.iteration}.chat-export.json` });
    }
    if (resource.rawChatUrl) chatEntries.push({ url: resource.rawChatUrl, entryName: `${id}/run.chat-export.json` });

    for (const { url, entryName } of chatEntries) {
      try {
        const blobName = blobNameFromSnapshotsUrl(url);
        if (!blobName) continue;

        const blobClient = containerClient.getBlockBlobClient(blobName);
        const downloadResponse = await blobClient.download();
        if (!downloadResponse.readableStreamBody || !downloadResponse.contentLength) continue;

        const entry = pack.entry({ name: entryName, size: downloadResponse.contentLength });
        await pipeline(downloadResponse.readableStreamBody, entry);
      } catch (blobError) {
        if (blobError instanceof RestError && (blobError.statusCode === 404 || blobError.code === "ContainerNotFound" || blobError.code === "BlobNotFound")) {
          continue;
        }
        throw blobError;
      }
    }

    // Finalize the tar archive
    pack.finalize();
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    } else {
      // Headers already sent — destroy the response to signal an error to the client
      res.destroy();
    }
  }
  },
});

// --- Runs upload (import downloaded archives) ---

// Download a HAR (HTTP Archive) file for a specific request or turn
// For one-shot runs: GET /api/v1/requests/:id/har
// For multi-turn runs: GET /api/v1/requests/:id/har?iteration=N
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/har",
  tags: ["Requests"],
  summary: "Download HAR file",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "HAR-format JSON file",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;
    const iterationParam = req.query.iteration as string | undefined;

    const resource = await collection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Determine the harUrl — from a specific turn or from the top-level document
    let harUrl: string | undefined;
    let label: string;

    if (iterationParam) {
      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }
      const turn = resource.turns?.find((t: { iteration: number }) => t.iteration === iterNum);
      harUrl = turn?.harUrl;
      label = `${id}-iteration-${iterNum}`;
    } else {
      // One-shot: harUrl on document root; multi-turn fallback: last turn
      harUrl = resource.harUrl || resource.turns?.[resource.turns.length - 1]?.harUrl;
      label = id;
    }

    if (!harUrl) {
      res.status(404).json({ error: "No HAR capture available" });
      return;
    }

    // Connect to blob storage and proxy the HAR file
    let blobServiceClient: BlobServiceClient;
    if (storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    const parsedUrl = new URL(harUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = parsedUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid HAR URL format" });
      return;
    }
    const blobName = parsedUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download HAR file" });
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${label}.har"`);
    if (downloadResponse.contentLength) {
      res.setHeader("Content-Length", downloadResponse.contentLength);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "HAR file not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// Download a session recording video for a specific request or turn
// For one-shot runs: GET /api/v1/requests/:id/video?index=0
// For multi-turn runs: GET /api/v1/requests/:id/video?iteration=N&index=0
// For setup videos:   GET /api/v1/requests/:id/video?phase=setup&index=0
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/video",
  tags: ["Requests"],
  summary: "Download session recording",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "WebM video recording (supports Range requests)",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;
    const iterationParam = req.query.iteration as string | undefined;
    const phaseParam = req.query.phase as string | undefined;
    const indexParam = req.query.index as string | undefined;
    const videoIndex = indexParam ? parseInt(indexParam, 10) : 0;

    if (isNaN(videoIndex) || videoIndex < 0) {
      res.status(400).json({ error: "Invalid video index" });
      return;
    }

    const resource = await collection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Determine the videoUrls array — from setup, a specific turn, or from the top-level document
    let videoUrls: string[] | undefined;
    let label: string;

    if (phaseParam === "setup") {
      videoUrls = resource.setupVideoUrls;
      label = `${id}-setup-video-${videoIndex}`;
    } else if (iterationParam) {
      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }
      const turn = resource.turns?.find(t => t.iteration === iterNum);
      videoUrls = turn?.videoUrls;
      label = `${id}-iteration-${iterNum}-video-${videoIndex}`;
    } else {
      // One-shot: videoUrls on document root; multi-turn fallback: last turn
      videoUrls = resource.videoUrls ?? resource.turns?.[resource.turns.length - 1]?.videoUrls;
      label = `${id}-video-${videoIndex}`;
    }

    if (!videoUrls || videoUrls.length === 0) {
      res.status(404).json({ error: "No video recordings available" });
      return;
    }

    if (videoIndex >= videoUrls.length) {
      res.status(404).json({ error: `Video index ${videoIndex} not found (${videoUrls.length} available)` });
      return;
    }

    const videoUrl = videoUrls[videoIndex];

    // Connect to blob storage and proxy the video file
    let blobServiceClient: BlobServiceClient;
    if (storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    const parsedUrl = new URL(videoUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = parsedUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid video URL format" });
      return;
    }
    const blobName = parsedUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    // Get blob properties for content length
    const properties = await blobClient.getProperties();
    const totalSize = properties.contentLength ?? 0;

    // Support HTTP Range requests for video seeking
    const rangeHeader = req.headers.range;
    if (rangeHeader && totalSize > 0) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const chunkSize = end - start + 1;

        const downloadResponse = await blobClient.download(start, chunkSize);
        if (!downloadResponse.readableStreamBody) {
          res.status(500).json({ error: "Failed to download video file" });
          return;
        }

        res.status(206);
        res.setHeader("Content-Type", "video/webm");
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", chunkSize);
        downloadResponse.readableStreamBody.pipe(res);
        return;
      }
    }

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download video file" });
      return;
    }

    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", `inline; filename="${label}.webm"`);
    if (totalSize > 0) {
      res.setHeader("Content-Length", totalSize);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "Video file not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// POST /api/v1/runs/upload — Upload a run archive (tar.gz) to import a previously downloaded run
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/runs/upload",
  tags: ["Requests"],
  summary: "Import run archive",
  middleware: [upload.single("archive")],
  response: RequestResponseSchema,
  rawResponse: true,
  successStatus: 201,
  handler: async (req, res) => {
  const tempDir = mkdtempSync(join(tmpdir(), "run-upload-"));
  let uploadedFilePath: string | undefined;

  try {
    // Validate file was uploaded
    if (!req.file) {
      res.status(400).json({ error: "No archive file uploaded. Use 'archive' field for the tar.gz file." });
      return;
    }
    uploadedFilePath = req.file.path;

    // Extract archive to temp directory
    const extractDir = join(tempDir, "extracted");
    execSync(`mkdir -p "${extractDir}" && tar xzf "${uploadedFilePath}" -C "${extractDir}"`, { stdio: "pipe" });

    // Find the run directory (archive contains <id>/ folder with run.yaml)
    const entries = readdirSync(extractDir);
    if (entries.length === 0) {
      res.status(400).json({ error: "Archive is empty" });
      return;
    }

    // Determine run directory - could be at root or in a subdirectory
    let runDir = extractDir;
    let runYamlPath = join(extractDir, "run.yaml");
    
    if (!existsSync(runYamlPath)) {
      // run.yaml might be inside a subdirectory (e.g., <id>/run.yaml)
      // Check each top-level entry for run.yaml
      for (const entry of entries) {
        const subDir = join(extractDir, entry);
        const subRunYaml = join(subDir, "run.yaml");
        try {
          const stat = statSync(subDir);
          if (stat.isDirectory() && existsSync(subRunYaml)) {
            runDir = subDir;
            runYamlPath = subRunYaml;
            break;
          }
        } catch {
          // Entry might not be a directory, skip
        }
      }
    }

    if (!existsSync(runYamlPath)) {
      res.status(400).json({ error: "Invalid archive: run.yaml not found" });
      return;
    }

    // Parse run.yaml
    const runYamlContent = await readFile(runYamlPath, "utf-8");
    let runDoc: RequestDocument;
    try {
      runDoc = yamlParse(runYamlContent) as RequestDocument;
    } catch (parseErr) {
      res.status(400).json({ error: `Failed to parse run.yaml: ${parseErr}` });
      return;
    }

    // Validate required fields
    if (!runDoc._id) {
      res.status(400).json({ error: "Invalid run.yaml: missing _id field" });
      return;
    }
    if (!runDoc.scenario) {
      res.status(400).json({ error: "Invalid run.yaml: missing scenario field" });
      return;
    }
    if (!runDoc.workerType) {
      res.status(400).json({ error: "Invalid run.yaml: missing workerType field" });
      return;
    }
    if (!runDoc.status) {
      res.status(400).json({ error: "Invalid run.yaml: missing status field" });
      return;
    }

    // Validate status is terminal (cannot import in-flight runs)
    const terminalStatuses = ["completed", "failed", "exhausted"];
    if (!terminalStatuses.includes(runDoc.status)) {
      res.status(400).json({
        error: `Cannot upload in-flight run (status: ${runDoc.status}). Only terminal runs can be uploaded.`,
      });
      return;
    }

    // Check if run already exists
    const existingRun = await collection.findOne({ _id: runDoc._id });
    if (existingRun) {
      res.status(409).json({
        error: `Run with ID '${runDoc._id}' already exists`,
        existingStatus: existingRun.status,
      });
      return;
    }

    // Upload iteration snapshots to blob storage and update snapshotUrls
    const turns = runDoc.turns || [];
    const iterationDirs = readdirSync(runDir).filter(name => name.startsWith("iteration-"));
    
    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    await containerClient.createIfNotExists();

    for (const iterDir of iterationDirs) {
      const iterMatch = iterDir.match(/^iteration-(\d+)$/);
      if (!iterMatch) continue;
      
      const iterNum = parseInt(iterMatch[1], 10);
      const iterPath = join(runDir, iterDir);
      
      // Create tar.gz from iteration directory
      const iterArchive = join(tempDir, `iter-${iterNum}.tar.gz`);
      execSync(`tar czf "${iterArchive}" -C "${iterPath}" .`, { stdio: "pipe" });
      
      // Upload to blob storage
      const blobName = `${runDoc._id}/iteration-${iterNum}/workspace.tar.gz`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(iterArchive, {
        blobHTTPHeaders: { blobContentType: "application/gzip" },
        tags: { requestId: runDoc._id, iteration: String(iterNum) },
      });
      
      // Update turn's snapshotUrl
      const turn = turns.find(t => t.iteration === iterNum);
      if (turn) {
        turn.snapshotUrl = blockBlobClient.url;
      }
    }

    // Upload bundled HAR files to blob storage
    const detectedHarFiles = detectBundledHarFiles(readdirSync(runDir));
    const topLevelHarUrl = await uploadBundledHarFiles({
      harFiles: detectedHarFiles,
      runDir,
      runId: runDoc._id,
      turns,
      containerClient,
    });
    if (topLevelHarUrl) {
      runDoc.harUrl = topLevelHarUrl;
    }

    // Upload bundled chat export files to blob storage
    const detectedChatFiles = detectBundledChatFiles(readdirSync(runDir));
    const topLevelChatUrl = await uploadBundledChatFiles({
      chatFiles: detectedChatFiles,
      runDir,
      runId: runDoc._id,
      turns,
      containerClient,
    });
    if (topLevelChatUrl) {
      runDoc.rawChatUrl = topLevelChatUrl;
    }

    // Prepare document for insertion
    const docToInsert: RequestDocument = {
      _id: runDoc._id,
      scenario: runDoc.scenario,
      workerType: runDoc.workerType as WorkerType,
      status: runDoc.status,
      createdAt: runDoc.createdAt ? new Date(runDoc.createdAt) : new Date(),
      updatedAt: runDoc.updatedAt ? new Date(runDoc.updatedAt) : undefined,
      turns: turns.map(t => ({
        ...t,
        timestamp: t.timestamp ? new Date(t.timestamp) : new Date(),
      })),
      ...(runDoc.result ? { result: runDoc.result } : {}),
      ...(runDoc.error ? { error: runDoc.error } : {}),
      ...(runDoc.maxIterations ? { maxIterations: runDoc.maxIterations } : {}),
      ...(runDoc.personaInstructions ? { personaInstructions: runDoc.personaInstructions } : {}),
      ...(runDoc.persona ? { persona: runDoc.persona } : {}),
      ...(runDoc.logs && Array.isArray(runDoc.logs) ? { logs: runDoc.logs } : {}),
      ...(runDoc.submissionId ? { submissionId: runDoc.submissionId } : { submissionId: uuidv4() }),
      ...(runDoc.harUrl ? { harUrl: runDoc.harUrl } : {}),
      ...(runDoc.rawChatUrl ? { rawChatUrl: runDoc.rawChatUrl } : {}),
      ...(runDoc.rawChatFormat ? { rawChatFormat: runDoc.rawChatFormat } : {}),
    };

    // Insert into MongoDB
    await collection.insertOne(docToInsert);

    console.log(`Uploaded run ${runDoc._id} with ${iterationDirs.length} iterations`);

    res.status(201).json({
      id: runDoc._id,
      status: runDoc.status,
      iterations: iterationDirs.length,
      message: "Run uploaded successfully",
    });

  } finally {
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
    if (uploadedFilePath && existsSync(uploadedFilePath)) {
      rmSync(uploadedFilePath, { force: true });
    }
  }
  },
});

// --- Criteria seed & CRUD (apiRoute) ---

// POST /api/v1/criteria/generate-prompt — AI-generate a criteria prompt
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/criteria/generate-prompt",
  tags: ["Criteria"],
  summary: "Generate criterion prompt from behavior",
  body: z.object({
    behavior: z.string(),
    currentId: z.string().optional(),
  }),
  response: z.object({ prompt: z.string() }),
  errorResponses: {
    400: { description: "Empty behavior string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { behavior, currentId } = req.body;
    if (!behavior.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
      return;
    }

    if (!isLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: register a github-models token or set GITHUB_MODELS_API_KEY" });
      return;
    }

    const allCriteria = await criteriaCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, dependsOn: 1, _id: 0 })
      .toArray();

    const existingCriteria = currentId
      ? allCriteria.filter((c: any) => c.id !== currentId)
      : allCriteria;

    try {
      const result = await generateCriteriaPrompt(
        behavior.trim(),
        existingCriteria as { id: string; prompt: string; dependsOn?: string[] }[],
      );
      console.log("[generate-prompt] LLM result:", JSON.stringify(result));
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not configured")) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// POST /api/v1/criteria/seed — bulk seed criteria from a JSON array
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/criteria/seed",
  tags: ["Criteria"],
  summary: "Seed criteria in bulk",
  body: z.object({
    criteria: z.array(CreateCriteriaInputSchema),
  }),
  response: z.object({
    seeded: z.number(),
    errors: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { criteria } = req.body;
    let seeded = 0;
    const errors: string[] = [];

    for (const config of criteria) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      try {
        await criteriaCollection.updateOne(
          { id: config.id.trim() },
          {
            $setOnInsert: {
              id: config.id.trim(),
              prompt: config.prompt.trim(),
              dependsOn: Array.isArray(config.dependsOn)
                ? config.dependsOn.map((d: any) => String(d).trim())
                : [],
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        seeded++;
      } catch (err) {
        errors.push(`Failed to seed ${config.id}: ${err}`);
      }
    }

    res.json({ seeded, errors });
  },
});

// GET /api/v1/criteria — list all criteria (with optional ?q= search)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "List criteria",
  query: z.object({ q: z.string().optional() }),
  response: z.array(CriteriaResponseSchema),
  handler: async (req, res) => {
    const q = req.query.q;
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    const criteria = await criteriaCollection.find(filter).toArray();
    criteria.sort((a, b) => a.id.localeCompare(b.id));
    res.json(criteria);
  },
});

// GET /api/v1/criteria/mdp — MDP state-transition graph across all runs
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/criteria/mdp",
  tags: ["Criteria"],
  summary: "Compute MDP transitions",
  query: z.object({
    criteria: z.string().optional(),
    features: z.string().optional(),
    since: z.string().optional(),
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
  }),
  response: z.object({}).passthrough(),
  handler: async (req, res) => {
    const selectedCriteria = req.query.criteria
      ? req.query.criteria.split(",").map((c) => c.trim()).filter(Boolean)
      : undefined;
    const selectedFeatures = req.query.features
      ? req.query.features.split(",").map((f) => f.trim()).filter(Boolean)
      : undefined;
    const sinceDate = req.query.since ? new Date(req.query.since) : undefined;

    const mdpFilter: Record<string, unknown> = {
      status: { $in: ["completed", "failed", "exhausted"] },
      deletedAt: { $exists: false },
    };
    if (req.query.worker) mdpFilter.workerType = req.query.worker;
    if (req.query.taskPromptId) mdpFilter.taskPromptId = req.query.taskPromptId;
    if (sinceDate && !isNaN(sinceDate.getTime())) {
      mdpFilter.updatedAt = { $gt: sinceDate };
    }

    const runs = await collection
      .find(mdpFilter)
      .project({
        _id: 1,
        scenario: 1,
        status: 1,
        turns: 1,
        updatedAt: 1,
        taskPromptId: 1,
      })
      .toArray();

    // Batch-lookup task prompts for their features
    const taskPromptIds = [
      ...new Set(runs.map((r) => r.taskPromptId).filter(Boolean)),
    ] as string[];
    const taskPromptFeatures = new Map<
      string,
      Array<{ featureId: string; detected: boolean; evaluated: boolean }>
    >();
    if (taskPromptIds.length > 0) {
      const taskPrompts = await taskPromptCollection
        .find({ _id: { $in: taskPromptIds } })
        .project({ _id: 1, features: 1 })
        .toArray();
      for (const tp of taskPrompts) {
        if (tp.features && tp.features.length > 0) {
          taskPromptFeatures.set(tp._id, tp.features);
        }
      }
    }

    const mdpRuns: MdpAnalyzableRun[] = runs.map((r) => ({
      scenario: r.scenario,
      status: r.status,
      turns: r.turns,
      updatedAt: r.updatedAt,
      promptFeatures: r.taskPromptId
        ? taskPromptFeatures.get(r.taskPromptId)
        : undefined,
    }));

    const mdpResult = computeMdp(mdpRuns, selectedCriteria, selectedFeatures);
    res.json(mdpResult);
  },
});

// GET /api/v1/criteria/graph — criteria DAG (nodes + edges)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/criteria/graph",
  tags: ["Criteria"],
  summary: "Get criteria DAG",
  response: CriteriaGraphSchema,
  handler: async (_req, res) => {
    const all = await criteriaCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();
    all.sort((a, b) => a.id.localeCompare(b.id));
    const nodes = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn || [],
    }));
    const edges: { source: string; target: string }[] = [];
    for (const c of all) {
      if (c.dependsOn) {
        for (const parentId of c.dependsOn) {
          edges.push({ source: parentId, target: c.id });
        }
      }
    }
    res.json({ nodes, edges });
  },
});

// GET /api/v1/criteria/:id — get single criterion
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Get criterion",
  params: z.object({ id: z.string() }),
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const criterion = await criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!criterion) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    const dependents = await criteriaCollection
      .find({ dependsOn: id, deletedAt: { $exists: false } })
      .toArray();

    res.json({ ...criterion, dependents: dependents.map((d) => d.id) });
  },
});

// POST /api/v1/criteria — create a new criterion
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "Create criterion",
  body: CreateCriteriaInputSchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    409: { description: "Criterion already exists" },
  },
  handler: async (req, res) => {
    const { id, prompt, dependsOn = [] } = req.body;

    // Check for duplicates
    const existing = await criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (existing) {
      res.status(409).json({ error: `Criteria '${id}' already exists` });
      return;
    }

    // Validate dependency references
    for (const depId of dependsOn) {
      const dep = await criteriaCollection.findOne({
        id: depId,
        deletedAt: { $exists: false },
      });
      if (!dep) {
        res.status(400).json({ error: `Dependency '${depId}' does not exist` });
        return;
      }
    }

    const doc: CriteriaDocument = {
      id,
      prompt: prompt.trim(),
      dependsOn,
      createdAt: new Date(),
    };

    await criteriaCollection.insertOne(doc as any);
    res.status(201).json(doc);
  },
});

// PUT /api/v1/criteria/:id — update a criterion
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Update criterion",
  params: z.object({ id: z.string() }),
  body: UpdateCriteriaInputSchema,
  response: CriteriaResponseSchema,
  errorResponses: {
    404: { description: "Criterion not found" },
    400: { description: "Invalid dependency reference or self-reference" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const { prompt, dependsOn } = req.body;

    const existing = await criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (prompt !== undefined) {
      update.prompt = prompt.trim();
    }
    if (dependsOn !== undefined) {
      // Validate dependency references
      for (const depId of dependsOn) {
        const dep = await criteriaCollection.findOne({
          id: depId,
          deletedAt: { $exists: false },
        });
        if (!dep) {
          res.status(400).json({ error: `Dependency '${depId}' does not exist` });
          return;
        }
      }
      // Self-reference check
      if (dependsOn.includes(id)) {
        res.status(400).json({ error: "A criterion cannot depend on itself" });
        return;
      }
      update.dependsOn = dependsOn;
    }

    await criteriaCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update },
    );

    const updated = await criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    res.json(updated);
  },
});

// DELETE /api/v1/criteria/:id — soft-delete (rejects if has dependents)
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/criteria/:id",
  tags: ["Criteria"],
  summary: "Soft-delete criterion",
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Criterion not found" },
    409: { description: "Criterion has dependents" },
  },
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await criteriaCollection.findOne({
      id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    // Check for dependents
    const dependents = await criteriaCollection
      .find({ dependsOn: id, deletedAt: { $exists: false } })
      .toArray();

    if (dependents.length > 0) {
      res.status(409).json({
        error: `Cannot delete '${id}': other criteria depend on it`,
        dependents: dependents.map((d) => d.id),
      });
      return;
    }

    await criteriaCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } },
    );

    res.json({ id, deleted: true });
  },
});

// --- Prompt Feature CRUD & extraction ---

// POST /api/v1/prompt-features/generate-prompt — AI-generate a prompt feature prompt from a behavior description
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/prompt-features/generate-prompt",
  tags: ["Prompt Features"],
  summary: "Generate prompt feature from behavior",
  body: z.object({
    behavior: z.string(),
    currentId: z.string().optional(),
  }),
  response: z.object({ prompt: z.string() }),
  errorResponses: {
    400: { description: "Empty behavior string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { behavior, currentId } = req.body;
    if (!behavior || typeof behavior !== "string" || !behavior.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
      return;
    }

    if (!isPromptFeatureLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: register a github-models token or set GITHUB_MODELS_API_KEY" });
      return;
    }

    const allFeatures = await promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, _id: 0 })
      .toArray();

    const existingFeatures = currentId
      ? allFeatures.filter((f: any) => f.id !== currentId)
      : allFeatures;

    try {
      const result = await generatePromptFeaturePrompt(
        behavior.trim(),
        existingFeatures as { id: string; prompt: string }[],
      );
      console.log("[prompt-features/generate-prompt] LLM result:", JSON.stringify(result));
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not configured")) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// POST /api/v1/prompt-features/seed — bulk seed prompt features from a JSON array
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/prompt-features/seed",
  tags: ["Prompt Features"],
  summary: "Seed prompt features in bulk",
  body: z.object({
    features: z.array(CreatePromptFeatureInputSchema),
  }),
  response: z.object({
    seeded: z.number(),
    errors: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { features } = req.body;

    let seeded = 0;
    const errors: string[] = [];

    for (const config of features) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      const trimmedId = String(config.id).trim();
      if (!/^[a-z][a-z0-9_]*$/.test(trimmedId)) {
        errors.push(`Skipping '${trimmedId}': id must start with a lowercase letter and contain only [a-z0-9_]`);
        continue;
      }
      try {
        await promptFeatureCollection.updateOne(
          { id: trimmedId },
          {
            $setOnInsert: {
              id: trimmedId,
              prompt: config.prompt.trim(),
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
        seeded++;
      } catch (err) {
        errors.push(`Failed to seed ${config.id}: ${err}`);
      }
    }

    res.json({ seeded, errors });
  },
});

// ==========================================
// Task Prompt endpoints
// ==========================================

// POST /api/v1/task-prompts/generate — AI-generate a task prompt from a description or variation
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/task-prompts/generate",
  tags: ["Task Prompts"],
  summary: "Generate task prompts",
  body: z.object({
    description: z.string().optional(),
    existingPrompt: z.string().optional(),
  }),
  response: z.object({ tasks: z.array(z.string()) }),
  successStatus: 200,
  errorResponses: {
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { description, existingPrompt } = req.body;

    if (!isTaskPromptLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: register a github-models token or set GITHUB_MODELS_API_KEY" });
      return;
    }

    // Fetch recent task prompts as context (avoid duplicates)
    const recentPrompts = await taskPromptCollection
      .find({ deletedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(20)
      .project({ text: 1, _id: 0 })
      .toArray();
    const existingTexts = recentPrompts.map((p: any) => p.text);

    const result = await generateTaskPrompt(
      {
        description: description?.trim(),
        existingPrompt: existingPrompt?.trim(),
      },
      existingTexts,
    );
    console.log("[task-prompts/generate] LLM result:", JSON.stringify(result));
    res.json(result);
  },
});

// GET /api/v1/task-prompts — list all task prompts (paginated, optional search)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "List task prompts",
  query: z.object({
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    search: z.string().optional(),
  }),
  response: z.object({
    items: z.array(TaskPromptResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  handler: async (req, res, next) => {
    const limit = req.query.limit ?? 50;
    const offset = req.query.offset ?? 0;
    const search = req.query.search;

    const { items, total } = await taskPromptStore.getAll({ limit, offset, search });
    res.json({ items, total, limit, offset });
  },
});

// GET /api/v1/task-prompts/:id — get a single task prompt by ID
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/task-prompts/:id",
  tags: ["Task Prompts"],
  summary: "Get task prompt",
  params: z.object({ id: z.string() }),
  response: TaskPromptResponseSchema,
  errorResponses: {
    404: { description: "Task prompt not found" },
  },
  handler: async (req, res, next) => {
    const { id } = req.params;
    const taskPrompt = await taskPromptStore.get(id);
    if (!taskPrompt) {
      res.status(404).json({ error: "Task prompt not found" });
      return;
    }
    res.json(taskPrompt);
  },
});

// POST /api/v1/task-prompts — create (or find existing) task prompt. Idempotent.
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "Create or find task prompt",
  body: CreateTaskPromptInputSchema,
  response: TaskPromptResponseSchema,
  errorResponses: {
    400: { description: "Empty text string" },
  },
  handler: async (req, res, next) => {
    const { text } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'text' string" });
      return;
    }

    const taskPrompt = await taskPromptStore.findOrCreate(text);
    res.status(201).json(taskPrompt);
  },
});

// DELETE /api/v1/task-prompts/:id — soft-delete a task prompt
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/task-prompts/:id",
  tags: ["Task Prompts"],
  summary: "Soft-delete task prompt",
  params: z.object({ id: z.string() }),
  response: z.object({ deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Task prompt not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      await taskPromptStore.delete(id);
      res.json({ deleted: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        res.status(404).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
});

// POST /api/v1/task-prompts/:id/extract-features — extract prompt features for a task prompt
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/task-prompts/:id/extract-features",
  tags: ["Task Prompts"],
  summary: "Extract features from task prompt",
  params: z.object({ id: z.string() }),
  query: z.object({ force: z.string().optional() }),
  body: z.object({ model: z.string().optional() }),
  response: z.object({
    taskPromptId: z.string(),
    features: z.array(PromptFeatureResultSchema),
    featuresExtractedAt: z.coerce.date().optional(),
    suggestedFeatures: z.array(SuggestedPromptFeatureSchema).optional(),
    cached: z.boolean(),
  }),
  successStatus: 200,
  errorResponses: {
    404: { description: "Task prompt not found" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { id } = req.params;
    const { model } = req.body;
    const force = req.query.force === "true";

    const taskPrompt = await taskPromptStore.get(id);
    if (!taskPrompt) {
      res.status(404).json({ error: "Task prompt not found" });
      return;
    }

    // Return cached features if available (unless force re-extraction)
    if (!force && taskPrompt.features && taskPrompt.features.length > 0) {
      res.json({
        taskPromptId: taskPrompt._id,
        features: taskPrompt.features,
        featuresExtractedAt: taskPrompt.featuresExtractedAt,
        cached: true,
      });
      return;
    }

    if (!isPromptFeatureLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: register a github-models token or set GITHUB_MODELS_API_KEY" });
      return;
    }

    const allFeatures = await promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();

    const featureConfigs = allFeatures.map(f => ({ id: f.id, prompt: f.prompt }));
    try {
      const { results, suggestedFeatures } = await extractPromptFeatures(taskPrompt.text, featureConfigs, model);

      // Store features on the task prompt entity
      const updated = await taskPromptStore.attachFeatures(id, results);

      res.json({
        taskPromptId: updated._id,
        features: updated.features,
        featuresExtractedAt: updated.featuresExtractedAt,
        suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : undefined,
        cached: false,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not configured")) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// POST /api/v1/prompt-features/extract-from-text — extract features from raw text without persisting
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/prompt-features/extract-from-text",
  tags: ["Prompt Features"],
  summary: "Extract features from text",
  body: z.object({
    text: z.string(),
    model: z.string().optional(),
  }),
  response: z.object({
    features: z.array(PromptFeatureResultSchema),
    suggestedFeatures: z.array(SuggestedPromptFeatureSchema).optional(),
    cached: z.boolean(),
  }),
  errorResponses: {
    400: { description: "Empty text string" },
    503: { description: "LLM not configured" },
  },
  handler: async (req, res, next) => {
    const { text, model } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Body must contain a non-empty 'text' string" });
      return;
    }

    if (!isPromptFeatureLlmAvailable()) {
      res.status(503).json({ error: "LLM not configured: register a github-models token or set GITHUB_MODELS_API_KEY" });
      return;
    }

    const allFeatures = await promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();

    const featureConfigs = allFeatures.map(f => ({ id: f.id, prompt: f.prompt }));
    try {
      const { results, suggestedFeatures } = await extractPromptFeatures(text.trim(), featureConfigs, model);

      res.json({
        features: results,
        suggestedFeatures: suggestedFeatures.length > 0 ? suggestedFeatures : undefined,
        cached: false,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not configured")) {
        res.status(503).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// PATCH /api/v1/task-prompts/:id/features/:featureId — toggle a feature's detected flag
apiRoute(app, registry, {
  method: "patch",
  path: "/api/v1/task-prompts/:id/features/:featureId",
  tags: ["Task Prompts"],
  summary: "Toggle feature flag on task prompt",
  params: z.object({ id: z.string(), featureId: z.string() }),
  body: PatchTaskPromptFeatureInputSchema,
  response: TaskPromptResponseSchema,
  errorResponses: {
    400: { description: "Invalid detected value" },
    404: { description: "Task prompt or feature not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, featureId } = req.params;
      const { detected } = req.body;

      if (typeof detected !== "boolean") {
        res.status(400).json({ error: "'detected' must be a boolean" });
        return;
      }

      const updated = await taskPromptStore.toggleFeature(id, featureId, detected);
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
});

// List all prompt features (with optional search)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "List features",
  query: z.object({ q: z.string().optional() }),
  response: z.array(PromptFeatureResponseSchema),
  handler: async (req, res) => {
    const q = req.query.q;
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    const features = await promptFeatureCollection.find(filter).toArray();
    features.sort((a, b) => a.id.localeCompare(b.id));
    res.json(features);
  },
});

// Get single prompt feature by ID
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Get feature",
  params: z.object({ id: z.string() }),
  response: PromptFeatureResponseSchema,
  errorResponses: {
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const feature = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!feature) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    res.json(feature);
  },
});

// Create a new prompt feature
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "Create feature",
  body: CreatePromptFeatureInputSchema,
  response: PromptFeatureResponseSchema,
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    409: { description: "Feature already exists" },
  },
  handler: async (req, res) => {
    const { id, prompt } = req.body;

    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required and must be a string" });
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      res.status(400).json({ error: "id must start with a lowercase letter and contain only [a-z0-9_]" });
      return;
    }
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required and must be a string" });
      return;
    }

    const existing = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      res.status(409).json({ error: `Prompt feature '${id}' already exists` });
      return;
    }

    const doc: PromptFeatureDocument = {
      id,
      prompt: prompt.trim(),
      createdAt: new Date(),
    };

    await promptFeatureCollection.insertOne(doc as any);
    res.status(201).json(doc);
  },
});

// Update a prompt feature
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Update feature",
  params: z.object({ id: z.string() }),
  body: UpdatePromptFeatureInputSchema,
  response: PromptFeatureResponseSchema,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;
    const { prompt } = req.body;

    const existing = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (prompt !== undefined) {
      if (typeof prompt !== "string") {
        res.status(400).json({ error: "prompt must be a string" });
        return;
      }
      update.prompt = prompt.trim();
    }

    await promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    const updated = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    res.json(updated);
  },
});

// Delete a prompt feature (soft-delete)
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/prompt-features/:id",
  tags: ["Prompt Features"],
  summary: "Soft-delete feature",
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), deleted: z.boolean() }),
  errorResponses: {
    404: { description: "Feature not found" },
  },
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    await promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    res.json({ id, deleted: true });
  },
});

// ==================== Report Endpoints ====================

// Create a report for a run (POST /api/v1/reports)
// Accepts optional templateId to associate the report with a report template.
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "Create report",
  body: CreateReportInputSchema,
  response: ReportResponseSchema,
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Run or template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestId, templateId } = req.body;

      if (!requestId || typeof requestId !== "string") {
        res.status(400).json({ error: "requestId is required and must be a string" });
        return;
      }

      // Verify the run exists
      const run = await collection.findOne({ _id: requestId });
      if (!run) {
        res.status(404).json({ error: `Run ${requestId} not found` });
        return;
      }

      // Verify the template exists (if specified)
      if (templateId) {
        const template = await reportTemplateCollection.findOne({ id: templateId, deletedAt: { $exists: false } });
        if (!template) {
          res.status(404).json({ error: `Report template '${templateId}' not found` });
          return;
        }
      }

      const reportId = uuidv4();

      const reportDoc: ReportDocument = {
        _id: reportId,
        requestId,
        ...(templateId ? { templateId } : {}),
        status: "pending",
        logs: [],
        createdAt: new Date(),
      };

      await reportCollection.insertOne(reportDoc);

      // Queue the report for processing
      const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
      await reportQueueClient.sendMessage(messageContent);

      console.log(`Created report ${reportId} for run ${requestId}${templateId ? ` (template: ${templateId})` : ""} and queued for processing`);

      res.status(201).json({
        id: reportId,
        requestId,
        ...(templateId ? { templateId } : {}),
        status: "pending",
        message: "Report generation queued",
      });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "List reports",
  query: z.object({ requestId: z.string().optional() }),
  response: z.array(ReportResponseSchema),
  handler: async (req, res, next) => {
    try {
      const requestIdFilter = req.query.requestId as string;
      const filter: Record<string, unknown> = {};
      if (requestIdFilter) {
        filter.requestId = requestIdFilter;
      }

      const reports = await reportCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      // Enrich reports with the task from their associated run
      const requestIds = [...new Set(reports.map(r => r.requestId))];
      const runs = requestIds.length > 0
        ? await collection.find({ _id: { $in: requestIds } as any }, { projection: { _id: 1, "scenario.task": 1 } }).toArray()
        : [];
      const taskByRequestId = new Map(runs.map(r => [r._id, r.scenario?.task]));

      res.json(reports.map(r => ({ ...r, id: r._id, task: taskByRequestId.get(r.requestId) })));
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports/bulk-create",
  tags: ["Reports"],
  summary: "Bulk create reports",
  body: BulkCreateReportsInputSchema,
  response: z.array(ReportResponseSchema),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Verify all runs exist
      const runs = await collection.find({ _id: { $in: requestIds } as any }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const notFound = requestIds.filter(id => !foundIds.has(id));

      // Create reports only for runs that exist
      const validIds = requestIds.filter(id => foundIds.has(id));
      const created: { reportId: string; requestId: string }[] = [];

      for (const requestId of validIds) {
        const reportId = uuidv4();
        const reportDoc: ReportDocument = {
          _id: reportId,
          requestId,
          status: "pending",
          logs: [],
          createdAt: new Date(),
        };
        await reportCollection.insertOne(reportDoc);

        const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
        await reportQueueClient.sendMessage(messageContent);

        created.push({ reportId, requestId });
      }

      console.log(`Bulk created ${created.length} reports for ${validIds.length} runs`);

      res.status(201).json({
        created: created.length,
        reports: created,
        notFound,
      });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports/bulk-status",
  tags: ["Reports"],
  summary: "Bulk get report statuses",
  body: BulkReportStatusInputSchema,
  response: z.array(ReportResponseSchema),
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Find the latest report for each requestId
      const reports = await reportCollection
        .find({ requestId: { $in: requestIds } })
        .sort({ createdAt: -1 })
        .toArray();

      // Build a map of requestId → latest report status
      const statusMap: Record<string, { reportId: string; status: string }> = {};
      for (const report of reports) {
        if (!statusMap[report.requestId]) {
          statusMap[report.requestId] = {
            reportId: report._id,
            status: report.status,
          };
        }
      }

      res.json(statusMap);
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/reports/:id",
  tags: ["Reports"],
  summary: "Get report",
  params: z.object({ id: z.string() }),
  response: ReportResponseSchema,
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const report = await reportCollection.findOne({ _id: id });

      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      res.json({ ...report, id: report._id });
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/reports/:id/logs",
  tags: ["Reports"],
  summary: "Stream report logs (SSE)",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const fromStart = req.query.fromStart === "true";

      const report = await reportCollection.findOne({ _id: id });

      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Replay existing logs if requested
      if (fromStart && report.logs && report.logs.length > 0) {
        for (const log of report.logs) {
          res.write(`data: ${JSON.stringify(log)}\n\n`);
        }
      }

      // If report already completed/failed, send done and close
      if (report.status === "completed" || report.status === "failed") {
        res.write(`event: done\ndata: {"status":"${report.status}"}\n\n`);
        res.end();
        return;
      }

      // Live streaming via Redis + Change Streams (same pattern as requests)
      let cleaned = false;
      let changeStream: ReturnType<typeof reportCollection.watch> | null = null;
      let redisSubscribed = false;

      const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
      let inactivityTimer: ReturnType<typeof setTimeout>;

      const resetInactivityTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          res.write(`event: timeout\ndata: {"message":"Stream timeout after 5 minutes of inactivity"}\n\n`);
          client.cleanup();
        }, INACTIVITY_TIMEOUT_MS);
      };

      const heartbeat = setInterval(() => {
        if (!cleaned) {
          res.write(`:\n\n`);
        }
      }, 30_000);

      const client: SSEClient = {
        res,
        onActivity: resetInactivityTimer,
        cleanup: () => {
          if (!cleaned) {
            cleaned = true;
            clearTimeout(inactivityTimer);
            clearInterval(heartbeat);
            if (changeStream) {
              changeStream.close().catch(err => console.error("Error closing report change stream:", err));
            }
            if (redisSubscribed) {
              unsubscribeClient(id, client);
            }
            res.end();
          }
        },
      };

      resetInactivityTimer();

      if (redisHost) {
        try {
          await subscribeClient(id, client);
          redisSubscribed = true;
        } catch (err) {
          console.error(`Redis subscription failed for report ${id}, using Change Streams only:`, err);
        }
      }

      try {
        changeStream = reportCollection.watch(
          [{ $match: { "documentKey._id": id, operationType: "update" } }],
          { fullDocument: "updateLookup" }
        );

        changeStream.on("change", (change) => {
          if (change.operationType === "update" && change.fullDocument) {
            const doc = change.fullDocument;
            if (doc.status === "completed" || doc.status === "failed") {
              res.write(`event: done\ndata: {"status":"${doc.status}"}\n\n`);
              client.cleanup();
            }
          }
        });

        changeStream.on("error", (err) => {
          console.error(`Report change stream error for ${id}:`, err);
        });
      } catch (err) {
        console.error(`Failed to create change stream for report ${id}:`, err);
      }

      req.on("close", () => client.cleanup());
    } catch (error) {
      next(error);
    }
  },
});

apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/requests/:id/reports",
  tags: ["Reports"],
  summary: "Get reports for request",
  params: z.object({ id: z.string() }),
  response: z.array(ReportResponseSchema),
  errorResponses: {
    404: { description: "Run not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      // Verify the run exists
      const run = await collection.findOne({ _id: id });
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      const reports = await reportCollection
        .find({ requestId: id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(reports.map(r => ({ ...r, id: r._id })));
    } catch (error) {
      next(error);
    }
  },
});

// POST /api/v1/reports/trigger — evaluate all report templates' triggers for a completed run
// Called by coding agent workers after a run completes. Creates a report per matching template.
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports/trigger",
  tags: ["Reports"],
  summary: "Trigger reports",
  body: TriggerReportsInputSchema,
  response: z.object({ triggered: z.number(), reports: z.array(ReportResponseSchema) }),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "Run not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestId } = req.body;

      if (!requestId || typeof requestId !== "string") {
        res.status(400).json({ error: "requestId is required and must be a string" });
        return;
      }

      // Fetch the completed run
      const run = await collection.findOne({ _id: requestId });
      if (!run) {
        res.status(404).json({ error: `Run ${requestId} not found` });
        return;
      }

      // Fetch task prompt document (needed for promptFeature trigger evaluation)
      let taskPrompt: TaskPromptDocument | null = null;
      if (run.taskPromptId) {
        taskPrompt = await taskPromptCollection.findOne({ _id: run.taskPromptId });
      }

      // Load all active report templates
      const templates = await reportTemplateCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();

      // Evaluate each template's trigger against the run
      const created: Array<{ id: string; requestId: string; templateId: string; status: string }> = [];

      for (const template of templates) {
        // Cast the run to the shared RequestDocument shape for evaluateTrigger
        const triggerResult = evaluateTrigger(
          template.trigger as any,
          run as any,
          taskPrompt as any
        );

        if (triggerResult) {
          const reportId = uuidv4();
          const reportDoc: ReportDocument = {
            _id: reportId,
            requestId,
            templateId: template.id,
            status: "pending",
            logs: [],
            createdAt: new Date(),
          };
          await reportCollection.insertOne(reportDoc);
          const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
          await reportQueueClient.sendMessage(messageContent);

          created.push({ id: reportId, requestId, templateId: template.id, status: "pending" });
          console.log(`Trigger matched template '${template.id}' — created report ${reportId} for run ${requestId}`);
        }
      }

      console.log(`Trigger evaluation for run ${requestId}: ${created.length}/${templates.length} templates matched`);
      res.status(201).json({ triggered: created.length, reports: created });
    } catch (error) {
      next(error);
    }
  },
});

// POST /api/v1/reports/bulk-trigger — evaluate report templates for multiple runs at once
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports/bulk-trigger",
  tags: ["Reports"],
  summary: "Bulk trigger reports",
  body: BulkTriggerReportsInputSchema,
  response: z.array(z.object({}).passthrough()),
  successStatus: 201,
  errorResponses: {
    400: { description: "Invalid input" },
  },
  handler: async (req, res, next) => {
    try {
      const { requestIds } = req.body as { requestIds?: string[] };

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        res.status(400).json({ error: "requestIds must be a non-empty array of strings" });
        return;
      }

      // Fetch runs
      const runs = await collection.find({ _id: { $in: requestIds } as any }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const notFound = requestIds.filter(id => !foundIds.has(id));

      // Load all active templates
      const templates = await reportTemplateCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();

      const created: Array<{ reportId: string; requestId: string; templateId: string }> = [];

      for (const run of runs) {
        // Fetch task prompt for trigger evaluation
        let taskPrompt: TaskPromptDocument | null = null;
        if (run.taskPromptId) {
          taskPrompt = await taskPromptCollection.findOne({ _id: run.taskPromptId });
        }

        for (const template of templates) {
          const triggerResult = evaluateTrigger(
            template.trigger as any,
            run as any,
            taskPrompt as any
          );

          if (triggerResult) {
            const reportId = uuidv4();
            const reportDoc: ReportDocument = {
              _id: reportId,
              requestId: run._id,
              templateId: template.id,
              status: "pending",
              logs: [],
              createdAt: new Date(),
            };
            await reportCollection.insertOne(reportDoc);
            const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
            await reportQueueClient.sendMessage(messageContent);
            created.push({ reportId, requestId: run._id, templateId: template.id });
          }
        }
      }

      console.log(`Bulk trigger: created ${created.length} reports for ${runs.length} runs`);

      res.status(201).json({
        created: created.length,
        reports: created,
        notFound,
      });
    } catch (error) {
      next(error);
    }
  },
});

// ============================================================
// Report Template CRUD routes (/api/v1/report-templates)
// ============================================================

// Get the default system prompt used when no template override is set
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/report-templates/default-system-prompt",
  tags: ["Report Templates"],
  summary: "Get default system prompt",
  response: z.object({ content: z.string() }),
  handler: (_req, res) => {
    res.json({ content: REPORT_SYSTEM_PROMPT });
  },
});

// List all report templates
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "List report templates",
  query: z.object({ q: z.string().optional() }),
  response: z.array(ReportTemplateResponseSchema),
  handler: async (req, res, next) => {
    try {
      const q = req.query.q as string | undefined;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
      if (q) {
        filter.$or = [
          { id: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }
      const templates = await reportTemplateCollection.find(filter).toArray();
      templates.sort((a, b) => a.id.localeCompare(b.id));
      res.json(templates);
    } catch (error) {
      next(error);
    }
  },
});

// Get single report template by ID
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Get report template",
  params: z.object({ id: z.string() }),
  response: ReportTemplateResponseSchema,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const template = await reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!template) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }
      res.json(template);
    } catch (error) {
      next(error);
    }
  },
});

// Create a report template
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "Create report template",
  body: CreateReportTemplateInputSchema,
  response: ReportTemplateResponseSchema,
  errorResponses: {
    409: { description: "Report template already exists" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, name, description, userPrompt, systemPrompt, trigger } = req.body;

      if (!id || typeof id !== "string") {
        res.status(400).json({ error: "id is required and must be a string" });
        return;
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        res.status(400).json({ error: "id must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      if (!userPrompt || typeof userPrompt !== "string") {
        res.status(400).json({ error: "userPrompt is required and must be a string" });
        return;
      }

      // Validate systemPrompt if provided
      if (systemPrompt !== undefined) {
        if (!systemPrompt || typeof systemPrompt !== "object") {
          res.status(400).json({ error: "systemPrompt must be an object with 'mode' and 'content'" });
          return;
        }
        if (!["append", "override"].includes(systemPrompt.mode)) {
          res.status(400).json({ error: "systemPrompt.mode must be 'append' or 'override'" });
          return;
        }
        if (!systemPrompt.content || typeof systemPrompt.content !== "string") {
          res.status(400).json({ error: "systemPrompt.content is required and must be a string" });
          return;
        }
      }

      // Validate trigger if provided
      if (trigger !== undefined) {
        const triggerError = validateTrigger(trigger);
        if (triggerError) {
          res.status(400).json({ error: triggerError });
          return;
        }
      }

      // Check for duplicate id
      const existing = await reportTemplateCollection.findOne({ id });
      if (existing && !existing.deletedAt) {
        res.status(409).json({ error: `Report template '${id}' already exists` });
        return;
      }

      const now = new Date();

      if (existing && existing.deletedAt) {
        // Un-delete: update the soft-deleted document
        await reportTemplateCollection.updateOne(
          { id },
          {
            $set: {
              name,
              ...(description !== undefined ? { description } : {}),
              userPrompt,
              ...(systemPrompt !== undefined ? { systemPrompt } : {}),
              ...(trigger !== undefined ? { trigger } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await reportTemplateCollection.findOne({ id });
        res.status(201).json(updated);
      } else {
        const templateDoc: ReportTemplateDocument = {
          id,
          name,
          ...(description ? { description } : {}),
          userPrompt,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(trigger ? { trigger } : {}),
          createdAt: now,
        };
        await reportTemplateCollection.insertOne(templateDoc as any);
        res.status(201).json(templateDoc);
      }
    } catch (error) {
      next(error);
    }
  },
});

// Update a report template
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Update report template",
  params: z.object({ id: z.string() }),
  body: UpdateReportTemplateInputSchema,
  response: ReportTemplateResponseSchema,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, description, userPrompt, systemPrompt, trigger } = req.body;

      const existing = await reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (description !== undefined) updateFields.description = description;
      if (userPrompt !== undefined) {
        if (typeof userPrompt !== "string" || !userPrompt.trim()) {
          res.status(400).json({ error: "userPrompt must be a non-empty string" });
          return;
        }
        updateFields.userPrompt = userPrompt;
      }
      if (systemPrompt !== undefined) {
        if (systemPrompt === null) {
          // Allow removing systemPrompt by setting to null
          updateFields.systemPrompt = undefined;
        } else {
          if (!["append", "override"].includes(systemPrompt.mode)) {
            res.status(400).json({ error: "systemPrompt.mode must be 'append' or 'override'" });
            return;
          }
          if (!systemPrompt.content || typeof systemPrompt.content !== "string") {
            res.status(400).json({ error: "systemPrompt.content is required and must be a string" });
            return;
          }
          updateFields.systemPrompt = systemPrompt;
        }
      }
      if (trigger !== undefined) {
        if (trigger === null) {
          // Allow removing trigger (reverts to "always" behavior)
          updateFields.trigger = undefined;
        } else {
          const triggerError = validateTrigger(trigger);
          if (triggerError) {
            res.status(400).json({ error: triggerError });
            return;
          }
          updateFields.trigger = trigger;
        }
      }

      await reportTemplateCollection.updateOne({ id }, { $set: updateFields });
      const updated = await reportTemplateCollection.findOne({ id });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  },
});

// Delete a report template (soft-delete)
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/report-templates/:id",
  tags: ["Report Templates"],
  summary: "Delete report template",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Report template not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const existing = await reportTemplateCollection.findOne({ id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: `Report template '${id}' not found` });
        return;
      }

      await reportTemplateCollection.updateOne(
        { id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

/**
 * Validate a ReportTrigger object shape.
 * Returns an error message if invalid, or null if valid.
 */
function validateTrigger(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object") {
    return "trigger must be an object";
  }
  const t = trigger as Record<string, unknown>;
  if (!t.type || typeof t.type !== "string") {
    return "trigger.type is required and must be a string";
  }
  switch (t.type) {
    case "always":
      return null;
    case "criteria":
      if (!Array.isArray(t.criteriaIds) || t.criteriaIds.length === 0) {
        return "trigger.criteriaIds must be a non-empty array of strings";
      }
      if (!t.criteriaIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.criteriaIds must only contain strings";
      }
      if (t.match !== undefined && t.match !== "any" && t.match !== "all") {
        return "trigger.match must be 'any' or 'all'";
      }
      return null;
    case "taskPrompt":
      if (!Array.isArray(t.taskPromptIds) || t.taskPromptIds.length === 0) {
        return "trigger.taskPromptIds must be a non-empty array of strings";
      }
      if (!t.taskPromptIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.taskPromptIds must only contain strings";
      }
      return null;
    case "promptFeature":
      if (!Array.isArray(t.featureIds) || t.featureIds.length === 0) {
        return "trigger.featureIds must be a non-empty array of strings";
      }
      if (!t.featureIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.featureIds must only contain strings";
      }
      if (t.match !== undefined && t.match !== "any" && t.match !== "all") {
        return "trigger.match must be 'any' or 'all'";
      }
      return null;
    default:
      return `Unknown trigger type: '${t.type}'. Valid types: always, criteria, taskPrompt, promptFeature`;
  }
}

// =============================================================================
// Token Manager proxy (admin CRUD - excludes /acquire which is worker-only)
// =============================================================================
const TOKEN_MANAGER_URL = process.env.TOKEN_MANAGER_URL || "";

if (TOKEN_MANAGER_URL) {
  const proxyToTokenManager = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetUrl = `${TOKEN_MANAGER_URL}${req.originalUrl}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const fetchOpts: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(targetUrl, fetchOpts);
      const contentType = upstream.headers.get("content-type") || "application/json";
      const body = await upstream.text();
      res.status(upstream.status).set("content-type", contentType).send(body);
    } catch (error) {
      next(error);
    }
  };

  // CRUD routes proxied to Token Manager (portal uses these)
  app.post("/api/v1/tokens/preview", proxyToTokenManager);   // must be before :id routes
  app.post("/api/v1/tokens", proxyToTokenManager);
  app.get("/api/v1/tokens", proxyToTokenManager);
  app.get("/api/v1/tokens/:id", proxyToTokenManager);
  app.put("/api/v1/tokens/:id", proxyToTokenManager);
  app.delete("/api/v1/tokens/:id", proxyToTokenManager);
  app.post("/api/v1/tokens/:id/validate", proxyToTokenManager);
  // NOTE: POST /api/v1/tokens/acquire is intentionally NOT proxied.
  // Workers call token-manager directly (ClusterIP) for /acquire.

  // Account CRUD routes proxied to Token Manager (portal uses these)
  app.post("/api/v1/accounts", proxyToTokenManager);
  app.get("/api/v1/accounts", proxyToTokenManager);
  app.get("/api/v1/accounts/:id", proxyToTokenManager);
  app.put("/api/v1/accounts/:id", proxyToTokenManager);
  app.delete("/api/v1/accounts/:id", proxyToTokenManager);
  // NOTE: GET /api/v1/accounts/:id/secrets is intentionally NOT proxied.
  // Key-updaters call token-manager directly (ClusterIP) for secrets.

  console.log(`[api] Token Manager proxy enabled → ${TOKEN_MANAGER_URL}`);
} else {
  console.log("[api] Token Manager proxy disabled (TOKEN_MANAGER_URL not set)");
}

// =============================================
// Coding Agents CRUD (apiRoute)
// =============================================

// List all agents
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "List agents",
  query: z.object({ modelProvider: z.string().optional() }),
  response: z.array(AgentResponseSchema),
  handler: async (req, res, next) => {
    try {
      const modelProvider = req.query?.modelProvider as string | undefined;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
      if (modelProvider) {
        filter.modelProvider = modelProvider;
      }
      const agents = await agentCollection
        .find(filter)
        .toArray();
      // Sort in JS for CosmosDB compatibility
      agents.sort((a, b) => a._id.localeCompare(b._id));
      res.json(agents.map((a) => ({ ...a, id: a._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Get a single agent
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Get agent",
  params: z.object({ id: z.string() }),
  response: AgentResponseSchema,
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const agent = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ ...agent, id: agent._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create or upsert an agent (idempotent — used by seed jobs)
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "Create or update agent (upsert)",
  body: CreateAgentInputSchema,
  response: AgentResponseSchema,
  errorResponses: {
    400: { description: "Validation error" },
  },
  handler: async (req, res, next) => {
    try {
      const { _id, name, description, modelProvider, supportedModels, defaultModel } = req.body;

      if (!_id || typeof _id !== "string") {
        res.status(400).json({ error: "_id is required and must be a string" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      // supportedModels is optional — if provided, must be a string array
      if (supportedModels !== undefined && (!Array.isArray(supportedModels) || !supportedModels.every((m: unknown) => typeof m === "string"))) {
        res.status(400).json({ error: "supportedModels must be an array of strings" });
        return;
      }
      if (defaultModel !== undefined && typeof defaultModel !== "string") {
        res.status(400).json({ error: "defaultModel must be a string" });
        return;
      }
      if (defaultModel && supportedModels && supportedModels.length > 0 && !supportedModels.includes(defaultModel)) {
        res.status(400).json({ error: "defaultModel must be one of supportedModels" });
        return;
      }

      const now = new Date();
      const existing = await agentCollection.findOne({ _id });

      if (existing) {
        // Upsert: update existing (un-delete if soft-deleted)
        // Only update supportedModels if explicitly provided — prevents registration
        // jobs from wiping models set by the scanner
        const effectiveModels = supportedModels ?? existing.supportedModels;
        await agentCollection.updateOne(
          { _id },
          {
            $set: {
              name,
              ...(description !== undefined ? { description } : {}),
              ...(modelProvider !== undefined ? { modelProvider } : {}),
              ...(supportedModels !== undefined ? { supportedModels } : {}),
              ...(defaultModel !== undefined ? { defaultModel } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await agentCollection.findOne({ _id });
        res.json({ ...updated, id: updated!._id });
      } else {
        // Create new — default to empty supportedModels if not provided
        const agentDoc: CodingAgentDocument = {
          _id,
          name,
          ...(description ? { description } : {}),
          ...(modelProvider ? { modelProvider } : {}),
          supportedModels: supportedModels ?? [],
          ...(defaultModel ? { defaultModel } : {}),
          createdAt: now,
        };
        await agentCollection.insertOne(agentDoc);
        res.status(201).json({ ...agentDoc, id: agentDoc._id });
      }
    } catch (error) {
      next(error);
    }
  },
});

// Update an agent
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Update agent",
  params: z.object({ id: z.string() }),
  body: UpdateAgentInputSchema,
  response: AgentResponseSchema,
  errorResponses: {
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, description, supportedModels, defaultModel } = req.body;

      const existing = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (description !== undefined) updateFields.description = description;
      if (supportedModels !== undefined) {
        if (!Array.isArray(supportedModels) || !supportedModels.every((m: unknown) => typeof m === "string")) {
          res.status(400).json({ error: "supportedModels must be an array of strings" });
          return;
        }
        updateFields.supportedModels = supportedModels;
      }
      if (defaultModel !== undefined) {
        const models = (supportedModels as string[] | undefined) || existing.supportedModels;
        if (defaultModel && models.length > 0 && !models.includes(defaultModel)) {
          res.status(400).json({ error: "defaultModel must be one of supportedModels" });
          return;
        }
        updateFields.defaultModel = defaultModel;
      }

      await agentCollection.updateOne({ _id: id }, { $set: updateFields });

      const updated = await agentCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete an agent
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/agents/:id",
  tags: ["Agents"],
  summary: "Delete agent",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      const existing = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      await agentCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// ============================================================
// Agent Versions routes (/api/v1/agents/:id/versions) (apiRoute)
// ============================================================

// List versions for an agent (optional ?status=active filter)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/agents/:id/versions",
  tags: ["Agents"],
  summary: "List agent versions",
  params: z.object({ id: z.string() }),
  query: z.object({ status: z.string().optional() }),
  response: z.array(AgentVersionSchema),
  errorResponses: {
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.query;

      const agent = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      let versions = agent.versions ?? [];
      if (status && typeof status === "string") {
        versions = versions.filter((v) => v.status === status);
      }

      res.json(versions);
    } catch (error) {
      next(error);
    }
  },
});

// Register/upsert an agent version (keyed by agentVersion)
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/agents/:id/versions",
  tags: ["Agents"],
  summary: "Register agent version (upsert)",
  params: z.object({ id: z.string() }),
  body: RegisterAgentVersionInputSchema,
  response: AgentVersionSchema,
  errorResponses: {
    400: { description: "Validation error" },
    404: { description: "Agent not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { agentVersion, workerVersion, components, gitCommit, buildTime, imageTag, queueName } = req.body;

      // Validate required fields
      if (!agentVersion || typeof agentVersion !== "string") {
        res.status(400).json({ error: "agentVersion is required and must be a string" });
        return;
      }
      if (!workerVersion || typeof workerVersion !== "string") {
        res.status(400).json({ error: "workerVersion is required and must be a string" });
        return;
      }
      if (!components || typeof components !== "object" || Array.isArray(components)) {
        res.status(400).json({ error: "components is required and must be an object" });
        return;
      }
      if (!gitCommit || typeof gitCommit !== "string") {
        res.status(400).json({ error: "gitCommit is required and must be a string" });
        return;
      }
      if (!buildTime || typeof buildTime !== "string") {
        res.status(400).json({ error: "buildTime is required and must be a string" });
        return;
      }
      if (!imageTag || typeof imageTag !== "string") {
        res.status(400).json({ error: "imageTag is required and must be a string" });
        return;
      }
      if (!queueName || typeof queueName !== "string") {
        res.status(400).json({ error: "queueName is required and must be a string" });
        return;
      }

      const agent = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const now = new Date();
      const versionEntry: AgentVersion = {
        agentVersion,
        workerVersion,
        components,
        gitCommit,
        buildTime,
        imageTag,
        queueName,
        status: "active",
        createdAt: now,
      };

      // Upsert: update existing entry with same agentVersion or push new
      const existing = (agent.versions ?? []).find((v) => v.agentVersion === agentVersion);
      if (existing) {
        await agentCollection.updateOne(
          { _id: id, "versions.agentVersion": agentVersion },
          {
            $set: {
              "versions.$.workerVersion": workerVersion,
              "versions.$.components": components,
              "versions.$.gitCommit": gitCommit,
              "versions.$.buildTime": buildTime,
              "versions.$.imageTag": imageTag,
              "versions.$.queueName": queueName,
              "versions.$.status": "active",
              updatedAt: now,
            },
          }
        );
      } else {
        await agentCollection.updateOne(
          { _id: id },
          {
            $push: { versions: versionEntry },
            $set: { updatedAt: now },
          }
        );
      }

      res.status(existing ? 200 : 201).json(versionEntry);
    } catch (error) {
      next(error);
    }
  },
});

// Update an agent version's status (e.g. retire)
apiRoute(app, registry, {
  method: "patch",
  path: "/api/v1/agents/:id/versions/:agentVersion",
  tags: ["Agents"],
  summary: "Patch agent version",
  params: z.object({ id: z.string(), agentVersion: z.string() }),
  body: PatchAgentVersionInputSchema,
  response: AgentVersionSchema,
  errorResponses: {
    400: { description: "Invalid status value" },
    404: { description: "Agent or version not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id, agentVersion } = req.params;
      const { status } = req.body;

      if (!status || !(["active", "retired"] as string[]).includes(status)) {
        res.status(400).json({ error: "status must be 'active' or 'retired'" });
        return;
      }

      const agent = await agentCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const version = (agent.versions ?? []).find((v) => v.agentVersion === agentVersion);
      if (!version) {
        res.status(404).json({ error: "Version not found" });
        return;
      }

      await agentCollection.updateOne(
        { _id: id, "versions.agentVersion": agentVersion },
        {
          $set: {
            "versions.$.status": status,
            updatedAt: new Date(),
          },
        }
      );

      res.json({ ...version, status });
    } catch (error) {
      next(error);
    }
  },
});

// ============================================================
// Models routes (/api/v1/models) — lifecycle-tracked model scanning (apiRoute)
// ============================================================

const ModelSyncRequestSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      providerAvailableFrom: z.string().optional(),
      providerEndOfLife: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  scannedAt: z.string(),
});

// GET /api/v1/models — list models (filterable by agentId and/or provider)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/models",
  tags: ["Models"],
  summary: "List models",
  query: ListModelsQuerySchema,
  response: z.array(ModelResponseSchema),
  handler: async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.agentId) filter.agentId = req.query.agentId;
    if (req.query.provider) filter.provider = req.query.provider;

    const models = await modelCollection
      .find(filter)
      .sort({ modelId: 1 })
      .toArray();
    res.json(models);
  },
});

// GET /api/v1/models/:id — get a single model by compound ID (agentId:modelId)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/models/:id",
  tags: ["Models"],
  summary: "Get model",
  params: z.object({ id: z.string() }),
  response: ModelResponseSchema,
  handler: async (req, res) => {
    const model = await modelCollection.findOne({ _id: req.params.id });
    if (!model) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    res.json(model);
  },
});

// POST /api/v1/models/sync — bulk upsert with lifecycle reconciliation
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/models/sync",
  tags: ["Models"],
  summary: "Sync models from provider",
  body: ModelSyncRequestSchema,
  response: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  handler: async (req, res) => {
    const { agentId, provider, models, scannedAt } = req.body;
    const now = new Date(scannedAt);
    const scannedModelIds = new Set<string>();

    const added: string[] = [];
    const unchanged: string[] = [];

    // Upsert each scanned model
    for (const model of models) {
      if (!model.id) continue;
      scannedModelIds.add(model.id);

      const compoundId = `${agentId}:${model.id}`;
      const existing = await modelCollection.findOne({ _id: compoundId });

      if (existing) {
        const updateFields: Record<string, unknown> = { lastSeenAt: now };
        if (existing.disappearedAt) {
          updateFields.disappearedAt = undefined;
        }
        if (model.providerAvailableFrom) {
          updateFields.providerAvailableFrom = new Date(model.providerAvailableFrom);
        }
        if (model.providerEndOfLife) {
          updateFields.providerEndOfLife = new Date(model.providerEndOfLife);
        }
        if (model.metadata) {
          updateFields.metadata = model.metadata;
        }

        const unsetFields: Record<string, "" | true | 1> = {};
        if (existing.disappearedAt) {
          unsetFields.disappearedAt = "";
        }

        await modelCollection.updateOne(
          { _id: compoundId },
          {
            $set: updateFields,
            ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
          },
        );
        unchanged.push(model.id);
      } else {
        const doc: ModelDocument = {
          _id: compoundId,
          modelId: model.id,
          provider,
          agentId,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(model.providerAvailableFrom
            ? { providerAvailableFrom: new Date(model.providerAvailableFrom) }
            : {}),
          ...(model.providerEndOfLife
            ? { providerEndOfLife: new Date(model.providerEndOfLife) }
            : {}),
          ...(model.metadata ? { metadata: model.metadata } : {}),
        };
        await modelCollection.insertOne(doc);
        added.push(model.id);
      }
    }

    // Mark disappeared models
    const existingModels = await modelCollection
      .find({ agentId, provider, disappearedAt: { $exists: false } })
      .toArray();

    const removed: string[] = [];
    for (const existing of existingModels) {
      if (!scannedModelIds.has(existing.modelId)) {
        await modelCollection.updateOne(
          { _id: existing._id },
          { $set: { disappearedAt: now } },
        );
        removed.push(existing.modelId);
      }
    }

    // Update agent's supportedModels with active (non-disappeared) models
    const activeModels = await modelCollection
      .find({ agentId, disappearedAt: { $exists: false } })
      .toArray();
    const activeModelIds = activeModels.map((m) => m.modelId).sort();

    const agent = await agentCollection.findOne({ _id: agentId });
    if (agent) {
      const needsDefault =
        !agent.defaultModel || !activeModelIds.includes(agent.defaultModel);
      let autoDefault: string | undefined;
      if (needsDefault && activeModels.length > 0) {
        const sorted = [...activeModels].sort((a, b) => {
          const dateA = a.providerAvailableFrom ?? a.firstSeenAt;
          const dateB = b.providerAvailableFrom ?? b.firstSeenAt;
          return new Date(dateB).getTime() - new Date(dateA).getTime();
        });
        autoDefault = sorted[0].modelId;
      }
      await agentCollection.updateOne(
        { _id: agentId },
        {
          $set: {
            supportedModels: activeModelIds,
            ...(autoDefault ? { defaultModel: autoDefault } : {}),
            updatedAt: new Date(),
          },
        },
      );
    }

    const report = { added, removed, unchanged };
    console.log(
      `Model sync for ${agentId}/${provider}: +${added.length} -${removed.length} =${unchanged.length}`,
    );
    res.json(report);
  },
});

// ============================================================
// MCP Server CRUD routes (/api/v1/mcp/servers) (apiRoute)
// ============================================================

const CreateMcpServerBodySchema = z.object({
  _id: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  name: z.string(),
  type: McpTransportTypeSchema,
  url: z.string(),
  headers: z.array(McpServerHeaderSchema).optional(),
  description: z.string().optional(),
});

// GET /api/v1/mcp/servers — list MCP servers
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "List MCP servers",
  response: z.array(McpServerResponseSchema),
  handler: async (_req, res) => {
    const servers = await mcpServerCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();
    servers.sort((a, b) => a._id.localeCompare(b._id));
    res.json(servers.map((s) => ({ ...s, id: s._id })));
  },
});

// GET /api/v1/mcp/servers/:id — get MCP server by slug
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Get MCP server",
  params: z.object({ id: z.string() }),
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const server = await mcpServerCollection.findOne({
      _id: req.params.id,
      deletedAt: { $exists: false },
    });
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    res.json({ ...server, id: server._id });
  },
});

// POST /api/v1/mcp/servers — create MCP server (upserts if soft-deleted)
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "Create MCP server",
  body: CreateMcpServerBodySchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const { _id, name, type, url, headers, description } = req.body;
    const now = new Date();
    const existing = await mcpServerCollection.findOne({ _id });

    if (existing) {
      // Upsert: un-delete if soft-deleted, update fields
      await mcpServerCollection.updateOne(
        { _id },
        {
          $set: {
            name,
            type,
            url,
            ...(headers !== undefined ? { headers } : {}),
            ...(description !== undefined ? { description } : {}),
            updatedAt: now,
          },
          $unset: { deletedAt: "" },
        },
      );
      const updated = await mcpServerCollection.findOne({ _id });
      res.json({ ...updated, id: updated!._id });
    } else {
      const serverDoc: McpServerDocument = {
        _id,
        name,
        type,
        url,
        ...(headers ? { headers } : {}),
        ...(description ? { description } : {}),
        createdAt: now,
      };
      await mcpServerCollection.insertOne(serverDoc);
      res.status(201).json({ ...serverDoc, id: serverDoc._id });
    }
  },
});

// PUT /api/v1/mcp/servers/:id — update MCP server
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Update MCP server",
  params: z.object({ id: z.string() }),
  body: UpdateMcpServerInputSchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const { id } = req.params;
    const { name, type, url, headers, description } = req.body;

    const existing = await mcpServerCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updateFields.name = name;
    if (type !== undefined) updateFields.type = type;
    if (url !== undefined) updateFields.url = url;
    if (headers !== undefined) updateFields.headers = headers;
    if (description !== undefined) updateFields.description = description;

    await mcpServerCollection.updateOne({ _id: id }, { $set: updateFields });
    const updated = await mcpServerCollection.findOne({ _id: id });
    res.json({ ...updated, id: updated!._id });
  },
});

// DELETE /api/v1/mcp/servers/:id — soft-delete MCP server
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Delete MCP server",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await mcpServerCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    await mcpServerCollection.updateOne(
      { _id: id },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );

    res.status(204).send();
  },
});

// =====================================================================
// Skills API
// =====================================================================

// List all skills (with optional ?q= text search)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "List all skills",
  response: z.array(SkillResponseSchema),
  handler: async (_req, res, next) => {
    try {
      const skills = await skillCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();
      skills.sort((a, b) => a._id.localeCompare(b._id));
      res.json(skills.map((s) => ({ ...s, id: s._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Unified skill search — merges internal DB + skills.sh results
// MUST be defined before /:id(*) to avoid being caught by the wildcard
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skills/search",
  tags: ["Skills"],
  summary: "Search skills (internal + external)",
  query: z.object({ q: z.string(), limit: z.string().optional() }),
  response: z.array(SkillSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      // Search internal DB (case-insensitive regex)
      const regex = { $regex: query, $options: "i" };
      const internalSkills = await skillCollection
        .find({
          deletedAt: { $exists: false },
          $or: [
            { name: regex },
            { skillName: regex },
            { description: regex },
          ],
        })
        .limit(limit)
        .toArray();

      const internalResults: SkillSearchResult[] = internalSkills.map((s) => ({
        id: s._id,
        name: s.name,
        source: s.source,
        description: s.description,
        internal: true,
      }));

      // Also track internal slugs to deduplicate
      const internalSlugs = new Set(internalSkills.map((s) => s._id));

      // Search skills.sh (external registry)
      let externalResults: SkillSearchResult[] = [];
      try {
        const skillsShUrl = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const externalRes = await fetch(skillsShUrl, {
          headers: { "User-Agent": "scope-mt-api" },
          signal: AbortSignal.timeout(5000),
        });
        if (externalRes.ok) {
          const data = await externalRes.json() as { skills?: Array<{ id: string; name: string; installs?: number; source?: string }> };
          if (data.skills && Array.isArray(data.skills)) {
            externalResults = data.skills
              .filter((s) => !internalSlugs.has(s.id))
              .map((s) => ({
                id: s.id,
                name: s.name,
                source: s.source ?? s.id.split("/").slice(0, 2).join("/"),
                internal: false,
                installs: s.installs,
              }));
          }
        }
      } catch {
        // skills.sh is optional — don't fail the request if it's down
        console.warn("skills.sh search failed, returning only internal results");
      }

      // Merge: internal first, then external
      const results = [...internalResults, ...externalResults].slice(0, limit);
      res.json(results);
    } catch (error) {
      next(error);
    }
  },
});

// Search external skills registry only (skills.sh)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skills/search/external",
  tags: ["Skills"],
  summary: "Search external skills registry",
  query: z.object({ q: z.string(), limit: z.string().optional() }),
  response: z.array(SkillSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      let externalResults: SkillSearchResult[] = [];
      try {
        const skillsShUrl = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const externalRes = await fetch(skillsShUrl, {
          headers: { "User-Agent": "scope-mt-api" },
          signal: AbortSignal.timeout(5000),
        });
        if (externalRes.ok) {
          const data = await externalRes.json() as { skills?: Array<{ id: string; name: string; installs?: number; source?: string; description?: string }> };
          if (data.skills && Array.isArray(data.skills)) {
            // Deduplicate against internal skills
            const internalSlugs = new Set(
              (await skillCollection.find({ deletedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id)
            );
            externalResults = data.skills
              .filter((s) => !internalSlugs.has(s.id))
              .map((s) => ({
                id: s.id,
                name: s.name,
                source: s.source ?? s.id.split("/").slice(0, 2).join("/"),
                description: s.description,
                internal: false,
                installs: s.installs,
              }));
          }
        }
      } catch {
        console.warn("skills.sh search failed");
      }

      res.json(externalResults.slice(0, limit));
    } catch (error) {
      next(error);
    }
  },
});

// List skill revisions for a given skill slug (source/skillName)
// NOTE: Must be before the generic GET /:id(*) to avoid the greedy wildcard matching "slug/revisions" as the id.
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skills/:id(*)/revisions",
  tags: ["Skills"],
  summary: "List skill revisions",
  query: z.object({ limit: z.string().optional() }),
  response: z.array(SkillRevisionResponseSchema),
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const limitStr = req.query.limit as string | undefined;
      const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10), 1), 100);

      const revisions = await skillRevisionStore.listBySkill(skill.source, skill.skillName, { limit });
      res.json(revisions);
    } catch (error) {
      next(error);
    }
  },
});

// Get skill by slug (must be after /search and /revisions to avoid wildcard matching)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skills/:id(*)",
  tags: ["Skills"],
  summary: "Get skill by slug",
  response: SkillResponseSchema,
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      res.json({ ...skill, id: skill._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create / import a skill
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "Create or import a skill",
  body: CreateSkillInputSchema,
  response: SkillResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { source, skillName, name, description, origin } = req.body;

      if (!source || typeof source !== "string") {
        res.status(400).json({ error: "source is required and must be a string (GitHub repo, e.g. 'vercel-labs/agent-skills')" });
        return;
      }
      if (!skillName || typeof skillName !== "string") {
        res.status(400).json({ error: "skillName is required and must be a string" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      if (origin !== undefined && origin !== "skills-sh" && origin !== "manual") {
        res.status(400).json({ error: "origin must be 'skills-sh' or 'manual'" });
        return;
      }

      const _id = `${source}/${skillName}`;
      const now = new Date();
      const existing = await skillCollection.findOne({ _id });

      if (existing) {
        // Upsert: un-delete if soft-deleted, update fields
        await skillCollection.updateOne(
          { _id },
          {
            $set: {
              name,
              source,
              skillName,
              ...(description !== undefined ? { description } : {}),
              ...(origin ? { origin } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await skillCollection.findOne({ _id });
        res.json({ ...updated, id: updated!._id });
      } else {
        const skillDoc: SkillDocument = {
          _id,
          source,
          skillName,
          name,
          ...(description ? { description } : {}),
          origin: origin || "manual",
          createdAt: now,
        };
        await skillCollection.insertOne(skillDoc as any);
        res.status(201).json({ ...skillDoc, id: skillDoc._id });
      }
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete a skill
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/skills/:id(*)",
  tags: ["Skills"],
  summary: "Soft-delete a skill",
  response: z.any(),
  rawResponse: true,
  successStatus: 204,
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];

      const existing = await skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      await skillCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      // Also delete all associated skill revisions
      await skillRevisionStore.deleteBySkill(existing.source, existing.skillName);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// =====================================================================
// Skill Revisions API
// =====================================================================

// Download skill revision archive (tar.gz) by ref — used by workers to fetch skill files through the API
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/:ref(*)/archive",
  tags: ["Skill Revisions"],
  summary: "Download skill revision archive",
  response: z.any(),
  rawResponse: true,
  responseDescription: "Binary tar.gz archive",
  errorResponses: {
    404: { description: "Skill revision or archive not found" },
    500: { description: "Blob storage error" },
  },
  handler: async (req, res, next) => {
    try {
      const ref = req.params.ref ?? req.params[0];
      // Strip trailing "/archive" that Express includes in the wildcard match
      const cleanRef = ref.replace(/\/archive$/, "");
      const revision = await skillRevisionStore.getByRef(cleanRef);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }

      if (!revision.archiveUrl) {
        res.status(404).json({ error: "Skill revision has no archive" });
        return;
      }

      // Parse the blob name from the archiveUrl
      // archiveUrl format: https://<account>.blob.core.windows.net/skill-archives/<blobName>
      // or Azurite: http://127.0.0.1:10000/devstoreaccount1/skill-archives/<blobName>
      const archiveUrlObj = new URL(revision.archiveUrl);
      const pathParts = archiveUrlObj.pathname.split("/").filter(Boolean);
      // pathParts: ["skill-archives", "<blobName>"] or ["devstoreaccount1", "skill-archives", "<blobName>"]
      const containerIdx = pathParts.indexOf("skill-archives");
      if (containerIdx === -1 || containerIdx >= pathParts.length - 1) {
        res.status(500).json({ error: "Cannot parse archive blob path" });
        return;
      }
      const blobName = pathParts.slice(containerIdx + 1).join("/");

      let blobServiceClient: BlobServiceClient;
      if (storageConnectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      } else if (storageAccountName) {
        const credential = new DefaultAzureCredential();
        blobServiceClient = new BlobServiceClient(
          `https://${storageAccountName}.blob.core.windows.net`,
          credential
        );
      } else {
        res.status(500).json({ error: "Blob storage not configured" });
        return;
      }

      const containerClient = blobServiceClient.getContainerClient("skill-archives");
      const blobClient = containerClient.getBlobClient(blobName);

      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody) {
        res.status(500).json({ error: "Failed to download archive from blob storage" });
        return;
      }

      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${blobName}"`);
      if (downloadResponse.contentLength !== undefined) {
        res.setHeader("Content-Length", downloadResponse.contentLength.toString());
      }

      downloadResponse.readableStreamBody.pipe(res);
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) {
        res.status(404).json({ error: "Archive blob not found in storage" });
        return;
      }
      next(error);
    }
  },
});

// Get skill revision by human-readable ref
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/:ref(*)",
  tags: ["Skill Revisions"],
  summary: "Get skill revision by ref",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill revision not found" },
  },
  handler: async (req, res, next) => {
    try {
      const ref = req.params.ref ?? req.params[0];
      const revision = await skillRevisionStore.getByRef(ref);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

// Get skill revision by ID (UUIDv5)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/skill-revisions/:id",
  tags: ["Skill Revisions"],
  summary: "Get skill revision by ID",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill revision not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const revision = await skillRevisionStore.get(id);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

// Resolve a skill — trigger resolution from GitHub and create a revision
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/skills/:id(*)/resolve",
  tags: ["Skills"],
  summary: "Trigger skill resolution",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill not found" },
    500: { description: "Blob storage error" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      // Upload archive to blob storage
      const uploadArchive = async (archiveName: string, data: Buffer): Promise<string> => {
        if (!storageConnectionString && !storageAccountName) {
          throw new Error("Blob storage not configured — cannot store skill archives");
        }

        let blobServiceClient: BlobServiceClient;
        if (storageConnectionString) {
          blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
        } else {
          const credential = new DefaultAzureCredential();
          blobServiceClient = new BlobServiceClient(
            `https://${storageAccountName}.blob.core.windows.net`,
            credential
          );
        }

        const containerClient = blobServiceClient.getContainerClient("skill-archives");
        await containerClient.createIfNotExists();
        const blockBlobClient = containerClient.getBlockBlobClient(archiveName);
        await blockBlobClient.upload(data, data.length, {
          blobHTTPHeaders: { blobContentType: "application/gzip" },
        });
        return blockBlobClient.url;
      };

      const revision = await skillResolver.resolve(skill.source, skill.skillName, skillRevisionStore, uploadArchive);
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

// =====================================================================
// Insights API (apiRoute)
// =====================================================================

// List all insights (with optional ?q= text search, ?blocked= filter)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "List insights",
  query: z.object({
    q: z.string().optional(),
    blocked: z.string().optional(),
  }),
  response: z.array(InsightResponseSchema),
  handler: async (req, res, next) => {
    try {
      const { q, blocked } = req.query;
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

      if (blocked !== undefined) {
        filter.blocked = blocked === "true";
      }

      if (q && typeof q === "string" && q.trim()) {
        // Case-insensitive regex search across title, description, category, and tags
        const regex = { $regex: q.trim(), $options: "i" };
        filter.$or = [
          { title: regex },
          { description: regex },
          { category: regex },
          { tags: regex },
        ];
      }

      const insights = await insightsCollection
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(insights.map((i) => ({ ...i, id: i._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Search insights by keyword (fuzzy regex match)
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/insights/search",
  tags: ["Insights"],
  summary: "Search insights",
  query: z.object({
    q: z.string(),
    blocked: z.string().optional(),
  }),
  response: z.array(InsightResponseSchema),
  handler: async (req, res, next) => {
    try {
      const { q, blocked } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

      if (blocked !== undefined) {
        filter.blocked = blocked === "true";
      } else {
        // Default: exclude blocked insights from search
        filter.blocked = { $ne: true };
      }

      // Split query into words and match all of them (AND) across title/description/tags
      const words = q.trim().split(/\s+/);
      filter.$and = words.map((word) => {
        const regex = { $regex: word, $options: "i" };
        return {
          $or: [
            { title: regex },
            { description: regex },
            { category: regex },
            { tags: regex },
          ],
        };
      });

      const insights = await insightsCollection
        .find(filter)
        .sort({ referenceCount: -1, createdAt: -1 })
        .limit(20)
        .toArray();

      res.json(insights.map((i) => ({ ...i, id: i._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Get a single insight
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Get insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const insight = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }
      res.json({ ...insight, id: insight._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create a new insight
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "Create insight",
  body: CreateInsightInputSchema,
  response: InsightResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { title, description, category, tags, createdBy, sourceReportId } = req.body;

      if (!title || typeof title !== "string" || !title.trim()) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      if (!description || typeof description !== "string" || !description.trim()) {
        res.status(400).json({ error: "description is required" });
        return;
      }

      const now = new Date();
      const doc: InsightDocument = {
        _id: uuidv4(),
        title: title.trim(),
        description: description.trim(),
        category: category?.trim() || undefined,
        tags: Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : undefined,
        upvotes: 0,
        downvotes: 0,
        blocked: false,
        referenceCount: 0,
        createdBy: createdBy === "agent" ? "agent" : "user",
        sourceReportId: sourceReportId || undefined,
        createdAt: now,
      };

      await insightsCollection.insertOne(doc);
      res.status(201).json({ ...doc, id: doc._id });
    } catch (error) {
      next(error);
    }
  },
});

// Update an insight
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Update insight",
  params: z.object({ id: z.string() }),
  body: UpdateInsightInputSchema,
  response: InsightResponseSchema,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      const { title, description, category, tags } = req.body;
      const updateFields: Record<string, unknown> = { updatedAt: new Date() };

      if (title !== undefined) updateFields.title = title.trim();
      if (description !== undefined) updateFields.description = description.trim();
      if (category !== undefined) updateFields.category = category?.trim() || undefined;
      if (tags !== undefined) updateFields.tags = Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : undefined;

      await insightsCollection.updateOne({ _id: id }, { $set: updateFields });
      const updated = await insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete an insight
apiRoute(app, registry, {
  method: "delete",
  path: "/api/v1/insights/:id",
  tags: ["Insights"],
  summary: "Delete insight",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await insightsCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// Upvote an insight
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/insights/:id/upvote",
  tags: ["Insights"],
  summary: "Upvote insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await insightsCollection.updateOne({ _id: id }, { $inc: { upvotes: 1 }, $set: { updatedAt: new Date() } });
      const updated = await insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Downvote an insight
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/insights/:id/downvote",
  tags: ["Insights"],
  summary: "Downvote insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await insightsCollection.updateOne({ _id: id }, { $inc: { downvotes: 1 }, $set: { updatedAt: new Date() } });
      const updated = await insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Block an insight
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/insights/:id/block",
  tags: ["Insights"],
  summary: "Block insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await insightsCollection.updateOne({ _id: id }, { $set: { blocked: true, updatedAt: new Date() } });
      const updated = await insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Unblock an insight
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/insights/:id/unblock",
  tags: ["Insights"],
  summary: "Unblock insight",
  params: z.object({ id: z.string() }),
  response: InsightResponseSchema,
  successStatus: 200,
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const existing = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      await insightsCollection.updateOne({ _id: id }, { $set: { blocked: false, updatedAt: new Date() } });
      const updated = await insightsCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    } catch (error) {
      next(error);
    }
  },
});

// Get reports that reference a specific insight
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/insights/:id/reports",
  tags: ["Insights"],
  summary: "Get reports referencing insight",
  params: z.object({ id: z.string() }),
  response: z.array(ReportResponseSchema),
  errorResponses: {
    404: { description: "Insight not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const insight = await insightsCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      const reports = await reportCollection
        .find({ "insightReferences.insightId": id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(reports.map((r) => ({ ...r, id: r._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Get insights referenced by a specific report
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/reports/:id/insights",
  tags: ["Reports"],
  summary: "Get insights for report",
  params: z.object({ id: z.string() }),
  response: z.array(InsightResponseSchema.extend({
    referencedAt: z.coerce.date().optional(),
    isNew: z.boolean().optional(),
  })),
  errorResponses: {
    404: { description: "Report not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const report = await reportCollection.findOne({ _id: id });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      if (!report.insightReferences || report.insightReferences.length === 0) {
        res.json([]);
        return;
      }

      const insightIds = report.insightReferences.map((ref) => ref.insightId);
      const insights = await insightsCollection
        .find({ _id: { $in: insightIds }, deletedAt: { $exists: false } })
        .toArray();

      // Enrich with reference metadata
      const enriched = insights.map((insight) => {
        const ref = report.insightReferences!.find((r) => r.insightId === insight._id);
        return {
          ...insight,
          id: insight._id,
          referencedAt: ref?.referencedAt,
          isNew: ref?.isNew,
        };
      });

      res.json(enriched);
    } catch (error) {
      next(error);
    }
  },
});

// Add an insight reference to a report
apiRoute(app, registry, {
  method: "post",
  path: "/api/v1/reports/:id/insights",
  tags: ["Reports"],
  summary: "Link insight to report",
  params: z.object({ id: z.string() }),
  body: z.object({
    insightId: z.string(),
    isNew: z.boolean().optional(),
  }),
  response: z.object({
    insightId: z.string(),
    referencedAt: z.coerce.date(),
    isNew: z.boolean(),
  }),
  errorResponses: {
    404: { description: "Report or insight not found" },
    409: { description: "Insight already referenced by this report" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const { insightId, isNew } = req.body;

      if (!insightId || typeof insightId !== "string") {
        res.status(400).json({ error: "insightId is required" });
        return;
      }

      const report = await reportCollection.findOne({ _id: id });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      const insight = await insightsCollection.findOne({ _id: insightId, deletedAt: { $exists: false } });
      if (!insight) {
        res.status(404).json({ error: "Insight not found" });
        return;
      }

      // Check if already referenced
      const alreadyReferenced = report.insightReferences?.some((ref) => ref.insightId === insightId);
      if (alreadyReferenced) {
        res.status(409).json({ error: "Insight already referenced by this report" });
        return;
      }

      const reference: InsightReference = {
        insightId,
        referencedAt: new Date(),
        isNew: isNew === true,
      };

      // Add reference to report
      await reportCollection.updateOne(
        { _id: id },
        { $push: { insightReferences: reference }, $set: { updatedAt: new Date() } }
      );

      // Increment reference count on insight
      await insightsCollection.updateOne(
        { _id: insightId },
        { $inc: { referenceCount: 1 }, $set: { updatedAt: new Date() } }
      );

      res.status(201).json(reference);
    } catch (error) {
      next(error);
    }
  },
});

// ─── Feature Flags (apiRoute) ─────────────────────────────────────────────────

// GET /api/v1/feature-flags — list all feature flags
apiRoute(app, registry, {
  method: "get",
  path: "/api/v1/feature-flags",
  tags: ["Feature Flags"],
  summary: "List feature flags",
  response: z.array(FeatureFlagResponseSchema),
  handler: async (_req, res) => {
    const flags = await featureFlagCollection.find({}).toArray();
    res.json(flags);
  },
});

// PUT /api/v1/feature-flags/:key — update a feature flag
apiRoute(app, registry, {
  method: "put",
  path: "/api/v1/feature-flags/:key",
  tags: ["Feature Flags"],
  summary: "Update feature flag",
  params: z.object({ key: z.string() }),
  body: UpdateFeatureFlagInputSchema,
  response: FeatureFlagResponseSchema,
  handler: async (req, res) => {
    const result = await featureFlagCollection.findOneAndUpdate(
      { key: req.params.key },
      { $set: { enabled: req.body.enabled, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) {
      res.status(404).json({ error: `Feature flag '${req.params.key}' not found` });
      return;
    }

    res.json(result);
  },
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

async function main(): Promise<void> {
  await initializeClients();

  // Mount OpenAPI docs (after all routes are registered)
  const openapiDocument = generateOpenAPIDocument();
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openapiDocument);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
}

// ─── Test support ────────────────────────────────────────────────────────────
// Allows tests to inject mock dependencies without starting the server.

export { app };

export interface TestDependencies {
  db?: Db;
  collection?: Collection<RequestDocument>;
  criteriaCollection?: Collection<CriteriaDocument>;
  promptFeatureCollection?: Collection<PromptFeatureDocument>;
  promptFeatureExtractionCollection?: Collection<PromptFeatureExtractionDocument>;
  reportCollection?: Collection<ReportDocument>;
  agentCollection?: Collection<CodingAgentDocument>;
  modelCollection?: Collection<ModelDocument>;
  mcpServerCollection?: Collection<McpServerDocument>;
  insightsCollection?: Collection<InsightDocument>;
  taskPromptCollection?: Collection<TaskPromptDocument>;
  taskPromptStore?: TaskPromptStore;
  featureFlagCollection?: Collection<FeatureFlagDocument>;
  reportTemplateCollection?: Collection<ReportTemplateDocument>;
  skillCollection?: Collection<SkillDocument>;
  skillRevisionCollection?: Collection<SkillRevisionDocument>;
  skillRevisionStore?: SkillRevisionStore;
  skillResolver?: SkillResolver;
  queueClients?: Map<WorkerType, QueueClient>;
  reportQueueClient?: QueueClient;
}

/** @internal — used by tests only to inject mock dependencies */
export function _injectTestDependencies(deps: TestDependencies): void {
  if (deps.db) db = deps.db;
  if (deps.collection) collection = deps.collection;
  if (deps.criteriaCollection) criteriaCollection = deps.criteriaCollection;
  if (deps.promptFeatureCollection) promptFeatureCollection = deps.promptFeatureCollection;
  if (deps.promptFeatureExtractionCollection) promptFeatureExtractionCollection = deps.promptFeatureExtractionCollection;
  if (deps.reportCollection) reportCollection = deps.reportCollection;
  if (deps.agentCollection) agentCollection = deps.agentCollection;
  if (deps.modelCollection) modelCollection = deps.modelCollection;
  if (deps.mcpServerCollection) mcpServerCollection = deps.mcpServerCollection;
  if (deps.insightsCollection) insightsCollection = deps.insightsCollection;
  if (deps.taskPromptCollection) taskPromptCollection = deps.taskPromptCollection;
  if (deps.taskPromptStore) taskPromptStore = deps.taskPromptStore;
  if (deps.featureFlagCollection) featureFlagCollection = deps.featureFlagCollection;
  if (deps.reportTemplateCollection) reportTemplateCollection = deps.reportTemplateCollection;
  if (deps.skillCollection) skillCollection = deps.skillCollection;
  if (deps.skillRevisionCollection) skillRevisionCollection = deps.skillRevisionCollection;
  if (deps.skillRevisionStore) skillRevisionStore = deps.skillRevisionStore;
  if (deps.skillResolver) skillResolver = deps.skillResolver;
  if (deps.queueClients) queueClients.clear(), deps.queueClients.forEach((v, k) => queueClients.set(k, v));
  if (deps.reportQueueClient) reportQueueClient = deps.reportQueueClient;
}

// ─── Start server (skipped in test environment) ──────────────────────────────

if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
