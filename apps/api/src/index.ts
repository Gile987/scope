// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Request, Response, NextFunction } from "express";
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
import { parse as yamlParse } from "yaml";
import { isLlmAvailable, generateCriteriaPrompt } from "./llm.js";
import {
  isLlmAvailable as isPromptFeatureLlmAvailable,
  generatePromptFeaturePrompt,
  extractPromptFeatures,
} from "./prompt-feature-llm.js";
import { computeAnalysis, AnalysisResponse, AnalyzableRun } from "./analysis.js";

const require = createRequire(import.meta.url);
const Redis = require("ioredis");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Multer configuration for file uploads (stored in temp directory)
const upload = multer({ dest: tmpdir() });

// Configuration from environment
// K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret
const mongoUri = process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017";
const mongoDatabase = process.env.MONGO_DATABASE || "requests-db";
const mongoCollection = process.env.MONGO_COLLECTION || "requests";
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString = process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const queueWorker1 = process.env.AZURE_STORAGE_QUEUE_WORKER_1 || "queue-coder-acp-claude-code";
const queueWorker2 = process.env.AZURE_STORAGE_QUEUE_WORKER_2 || "queue-coder-acp-copilot";
const queueReport = process.env.AZURE_STORAGE_QUEUE_REPORT || "report-queue";
const redisHost = process.env.REDIS_HOST || "";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
const redisPassword = process.env.REDIS_PASSWORD || "";
const port = parseInt(process.env.PORT || "3000", 10);

// Version information (injected at build time)
const GIT_COMMIT = process.env.GIT_COMMIT || "development";
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();

// Valid worker types
const VALID_WORKERS = ["coder-acp-claude-code", "coder-acp-copilot"] as const;
type WorkerType = (typeof VALID_WORKERS)[number];

// MongoDB clients
let mongoClient: MongoClient;
let db: Db;
let collection: Collection<RequestDocument>;
let criteriaCollection: Collection<CriteriaDocument>;
let promptFeatureCollection: Collection<PromptFeatureDocument>;
let promptFeatureExtractionCollection: Collection<PromptFeatureExtractionDocument>;
let reportCollection: Collection<ReportDocument>;
const queueClients: Map<WorkerType, QueueClient> = new Map();
let reportQueueClient: QueueClient;

// Criteria document interface
interface CriteriaDocument {
  id: string;
  prompt: string;
  dependsOn?: string[];
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

// Prompt feature document interfaces
interface PromptFeatureDocument {
  id: string;
  prompt: string;
  dependsOn?: string[];
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

interface PromptFeatureExtractionDocument {
  _id?: string;
  taskText: string;
  taskTextHash: string;
  promptFeatureResults: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
  extractedAt: Date;
  model?: string;
}

// Report document interface
interface ReportDocument {
  _id: string;
  requestId: string;
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
  createdAt: Date;
  updatedAt?: Date;
}

// Log event interface
interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

// Request document interface
interface RequestDocument {
  _id: string;
  scenario: { task: string; criteria: string[]; version?: 'v1' | 'v2' };
  workerType: WorkerType;
  status: "pending" | "processing" | "iterating" | "completed" | "failed" | "exhausted";
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
  }>;
  personaInstructions?: string;
  persona?: { personality: string; experience: string; verbosity: string; type: string };
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

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
  
  // Create index for createdAt (required for sorting in CosmosDB MongoDB API)
  try {
    await collection.createIndex({ createdAt: -1 });
    console.log("Created index on createdAt");
  } catch (err) {
    // Index may already exist
    console.log("Index on createdAt already exists or couldn't be created");
  }

  // Create unique index for criteria ID
  try {
    await criteriaCollection.createIndex({ id: 1 }, { unique: true });
    console.log("Created unique index on criteria.id");
  } catch (err) {
    console.log("Index on criteria.id already exists or couldn't be created");
  }

  // Create unique index for prompt feature ID
  try {
    await promptFeatureCollection.createIndex({ id: 1 }, { unique: true });
    console.log("Created unique index on prompt-features.id");
  } catch (err) {
    console.log("Index on prompt-features.id already exists or couldn't be created");
  }

  // Create unique index for prompt feature extraction task text hash (dedup)
  try {
    await promptFeatureExtractionCollection.createIndex({ taskTextHash: 1 }, { unique: true });
    console.log("Created unique index on prompt-feature-extractions.taskTextHash");
  } catch (err) {
    console.log("Index on prompt-feature-extractions.taskTextHash already exists or couldn't be created");
  }

  // Create indexes for reports collection
  try {
    await reportCollection.createIndex({ createdAt: -1 });
    await reportCollection.createIndex({ requestId: 1 });
    console.log("Created indexes on reports collection");
  } catch (err) {
    console.log("Indexes on reports collection already exist or couldn't be created");
  }

  // Seed criteria from YAML files on first boot (skipped — use POST /api/v1/criteria/seed)
  const criteriaCount = await criteriaCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Criteria collection has ${criteriaCount} documents`);

  const promptFeatureCount = await promptFeatureCollection.countDocuments({ deletedAt: { $exists: false } });
  console.log(`Prompt features collection has ${promptFeatureCount} documents`);
  
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

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", version: GIT_COMMIT });
});

// About endpoint
app.get("/about", (_req: Request, res: Response) => {
  res.json({
    name: "Multi-Worker API (MongoDB)",
    version: GIT_COMMIT,
    buildTime: BUILD_TIME,
    description: "API that routes requests to multiple workers via separate queues",
    workers: VALID_WORKERS,
  });
});

// Version endpoint
app.get("/api/v1/version", (_req: Request, res: Response) => {
  res.json({
    commit: GIT_COMMIT,
    buildTime: BUILD_TIME,
  });
});

// Submit a request
app.post("/api/v1/requests", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions, count = 1, promptFeatureExtractionId } = req.body;
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

    // Normalize scenario: ensure criteria is always an array, preserve version
    const scenario: RequestDocument['scenario'] = {
      task: scenarioObj.task as string,
      criteria: Array.isArray(scenarioObj.criteria) ? scenarioObj.criteria as string[] : [],
      ...(scenarioObj.version === 'v1' || scenarioObj.version === 'v2' ? { version: scenarioObj.version } : {}),
    };

    const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";
    const queueClient = queueClients.get(workerType)!;

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
          status: "pending",
          createdAt: new Date(),
          ...(maxIterations ? { maxIterations } : {}),
          ...(personaInstructions ? { personaInstructions } : {}),
          ...(personaObj ? { persona: personaObj } : {}),
          ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
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
        workerType,
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
      status: "pending",
      createdAt: new Date(),
      ...(maxIterations ? { maxIterations } : {}),
      ...(personaInstructions ? { personaInstructions } : {}),
      ...(personaObj ? { persona: personaObj } : {}),
      ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
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
      workerType,
      status: requestDoc.status,
      mode,
      message: "Request submitted successfully",
      scenario,
      ...(maxIterations ? { maxIterations } : {}),
    });
  } catch (error) {
    next(error);
  }
});

// Get request status
app.get("/api/v1/requests/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const resource = await collection.findOne({ _id: id });

    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Map _id back to id for API response
    res.json({ ...resource, id: resource._id });
  } catch (error) {
    next(error);
  }
});

// Stream logs for a request via SSE (with connection pooling)
app.get("/api/v1/requests/:id/logs", async (req: Request, res: Response, next: NextFunction) => {
  try {
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

  } catch (error) {
    next(error);
  }
});

// List all requests (excludes soft-deleted by default)
app.get("/api/v1/requests", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workerFilter = req.query.worker as string;
    const includeDeleted = req.query.includeDeleted === "true";
    
    const filter: Record<string, unknown> = {};
    if (workerFilter && VALID_WORKERS.includes(workerFilter as WorkerType)) {
      filter.workerType = workerFilter;
    }
    if (!includeDeleted) {
      filter.deletedAt = { $exists: false };
    }

    const resources = await collection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(resources.map(r => ({ ...r, id: r._id })));
  } catch (error) {
    next(error);
  }
});

// Analysis endpoint - compute pass@k, success@T, and iteration stats
app.get("/api/v1/analysis", async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

// Bulk re-submit requests (create new runs from existing ones)
app.post("/api/v1/requests/bulk-resubmit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, count = 1 } = req.body as { ids?: string[]; count?: number };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "Request body must include 'ids' array" });
      return;
    }

    if (typeof count !== "number" || count < 1 || count > 10) {
      res.status(400).json({ error: "count must be a number between 1 and 10" });
      return;
    }

    // Fetch original runs
    const originalRuns = await collection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } }
    ).toArray();

    const foundIds = new Set(originalRuns.map(r => r._id));
    const notFound = ids.filter(id => !foundIds.has(id));

    const newIds: string[] = [];
    const newDocs: RequestDocument[] = [];
    const queueMessages: Array<{ workerType: WorkerType; message: string }> = [];

    for (const original of originalRuns) {
      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        newIds.push(requestId);

        const newDoc: RequestDocument = {
          _id: requestId,
          scenario: original.scenario,
          workerType: original.workerType,
          status: "pending",
          createdAt: new Date(),
          ...(original.maxIterations ? { maxIterations: original.maxIterations } : {}),
          ...(original.personaInstructions ? { personaInstructions: original.personaInstructions } : {}),
          ...(original.persona ? { persona: original.persona } : {}),
        };

        newDocs.push(newDoc);

        const queueMessage: QueueMessage = { requestId };
        const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
        queueMessages.push({ workerType: original.workerType as WorkerType, message: messageContent });
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
    });
  } catch (error) {
    next(error);
  }
});

// Bulk soft-delete requests
app.delete("/api/v1/requests/bulk", async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

// Soft-delete a request
app.delete("/api/v1/requests/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

// Download a snapshot for a specific iteration
app.get("/api/v1/requests/:id/snapshots/:iteration", async (req: Request, res: Response, next: NextFunction) => {
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
    next(error);
  }
});

// --- Runs upload (import downloaded archives) ---

// POST /api/v1/runs/upload — Upload a run archive (tar.gz) to import a previously downloaded run
app.post("/api/v1/runs/upload", upload.single("archive"), async (req: Request, res: Response, next: NextFunction) => {
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
      // Note: logs are intentionally not imported (they were excluded from download)
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

  } catch (error) {
    next(error);
  } finally {
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
    if (uploadedFilePath && existsSync(uploadedFilePath)) {
      rmSync(uploadedFilePath, { force: true });
    }
  }
});

// --- Criteria seed & CRUD ---

// POST /api/v1/criteria/generate-prompt — AI-generate a criteria prompt from a behavior description
app.post("/api/v1/criteria/generate-prompt", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { behavior, currentId } = req.body;
    if (!behavior || typeof behavior !== "string" || !behavior.trim()) {
      return res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
    }

    if (!isLlmAvailable()) {
      return res.status(503).json({ error: "LLM not configured: GITHUB_MODELS_API_KEY is not set" });
    }

    // Fetch existing criteria to give the LLM context for parent/children suggestions
    const allCriteria = await criteriaCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, dependsOn: 1, _id: 0 })
      .toArray();

    // Exclude the current criterion when editing (to avoid self-reference)
    const existingCriteria = currentId
      ? allCriteria.filter((c: any) => c.id !== currentId)
      : allCriteria;

    const result = await generateCriteriaPrompt(
      behavior.trim(),
      existingCriteria as { id: string; prompt: string; dependsOn?: string[] }[],
    );
    console.log("[generate-prompt] LLM result:", JSON.stringify(result));
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not configured")) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/v1/criteria/seed — bulk seed criteria from a JSON array
// Body: { criteria: [{ id, prompt, dependsOn? }] }
app.post("/api/v1/criteria/seed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { criteria } = req.body;
    if (!Array.isArray(criteria)) {
      return res.status(400).json({ error: "Body must contain a 'criteria' array" });
    }

    let seeded = 0;
    const errors: string[] = [];

    for (const config of criteria) {
      if (!config.id || !config.prompt) {
        errors.push(`Skipping entry without id or prompt`);
        continue;
      }
      try {
        await criteriaCollection.updateOne(
          { id: config.id.trim() },
          {
            $setOnInsert: {
              id: config.id.trim(),
              prompt: config.prompt.trim(),
              dependsOn: Array.isArray(config.dependsOn) ? config.dependsOn.map((d: any) => String(d).trim()) : [],
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
  } catch (err) {
    next(err);
  }
});

// List all criteria (with optional search)
app.get("/api/v1/criteria", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const q = _req.query.q as string | undefined;
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
    if (q) {
      filter.$or = [
        { id: { $regex: q, $options: "i" } },
        { prompt: { $regex: q, $options: "i" } },
      ];
    }
    const criteria = await criteriaCollection.find(filter).toArray();
    // Sort in JS (CosmosDB doesn't support sort on non-_id fields without explicit indexing policy)
    criteria.sort((a, b) => a.id.localeCompare(b.id));
    res.json(criteria);
  } catch (error) {
    next(error);
  }
});

// Get criteria DAG graph (nodes + edges)
app.get("/api/v1/criteria/graph", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await criteriaCollection.find({ deletedAt: { $exists: false } }).toArray();
    all.sort((a, b) => a.id.localeCompare(b.id));
    const nodes = all.map(c => ({ id: c.id, prompt: c.prompt, dependsOn: c.dependsOn || [] }));
    const edges: { source: string; target: string }[] = [];
    for (const c of all) {
      if (c.dependsOn) {
        for (const parentId of c.dependsOn) {
          edges.push({ source: parentId, target: c.id });
        }
      }
    }
    res.json({ nodes, edges });
  } catch (error) {
    next(error);
  }
});

// Get single criterion by ID
app.get("/api/v1/criteria/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const criterion = await criteriaCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!criterion) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    // Find dependents (who depends on this criterion)
    const dependents = await criteriaCollection.find({
      dependsOn: id,
      deletedAt: { $exists: false },
    }).toArray();

    res.json({
      ...criterion,
      dependents: dependents.map(d => d.id),
    });
  } catch (error) {
    next(error);
  }
});

// Create a new criterion
app.post("/api/v1/criteria", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, prompt, dependsOn = [] } = req.body;

    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required and must be a string" });
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: "id must match [a-z0-9_-]+" });
      return;
    }
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required and must be a string" });
      return;
    }
    if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === "string")) {
      res.status(400).json({ error: "dependsOn must be an array of strings" });
      return;
    }

    // Check for duplicates
    const existing = await criteriaCollection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      res.status(409).json({ error: `Criteria '${id}' already exists` });
      return;
    }

    // Validate dependency references
    for (const depId of dependsOn) {
      const dep = await criteriaCollection.findOne({ id: depId, deletedAt: { $exists: false } });
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
  } catch (error) {
    next(error);
  }
});

// Update a criterion
app.put("/api/v1/criteria/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { prompt, dependsOn } = req.body;

    const existing = await criteriaCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
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
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === "string")) {
        res.status(400).json({ error: "dependsOn must be an array of strings" });
        return;
      }
      // Validate dependency references
      for (const depId of dependsOn) {
        const dep = await criteriaCollection.findOne({ id: depId, deletedAt: { $exists: false } });
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
      { $set: update }
    );

    const updated = await criteriaCollection.findOne({ id, deletedAt: { $exists: false } });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Delete a criterion (soft-delete, rejects if has dependents)
app.delete("/api/v1/criteria/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await criteriaCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Criteria '${id}' not found` });
      return;
    }

    // Check for dependents
    const dependents = await criteriaCollection.find({
      dependsOn: id,
      deletedAt: { $exists: false },
    }).toArray();

    if (dependents.length > 0) {
      const depIds = dependents.map(d => d.id).join(", ");
      res.status(409).json({
        error: `Cannot delete '${id}': other criteria depend on it`,
        dependents: dependents.map(d => d.id),
      });
      return;
    }

    await criteriaCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    res.json({ id, deleted: true });
  } catch (error) {
    next(error);
  }
});

// --- Prompt Feature CRUD & extraction ---

// POST /api/v1/prompt-features/generate-prompt — AI-generate a prompt feature prompt from a behavior description
app.post("/api/v1/prompt-features/generate-prompt", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { behavior, currentId } = req.body;
    if (!behavior || typeof behavior !== "string" || !behavior.trim()) {
      return res.status(400).json({ error: "Body must contain a non-empty 'behavior' string" });
    }

    if (!isPromptFeatureLlmAvailable()) {
      return res.status(503).json({ error: "LLM not configured: GITHUB_MODELS_API_KEY is not set" });
    }

    const allFeatures = await promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .project({ id: 1, prompt: 1, dependsOn: 1, _id: 0 })
      .toArray();

    const existingFeatures = currentId
      ? allFeatures.filter((f: any) => f.id !== currentId)
      : allFeatures;

    const result = await generatePromptFeaturePrompt(
      behavior.trim(),
      existingFeatures as { id: string; prompt: string; dependsOn?: string[] }[],
    );
    console.log("[prompt-features/generate-prompt] LLM result:", JSON.stringify(result));
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not configured")) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/v1/prompt-features/seed — bulk seed prompt features from a JSON array
app.post("/api/v1/prompt-features/seed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { features } = req.body;
    if (!Array.isArray(features)) {
      return res.status(400).json({ error: "Body must contain a 'features' array" });
    }

    let seeded = 0;
    const errors: string[] = [];

    for (const config of features) {
      if (!config.id || !config.prompt) {
        errors.push("Skipping entry without id or prompt");
        continue;
      }
      try {
        await promptFeatureCollection.updateOne(
          { id: config.id.trim() },
          {
            $setOnInsert: {
              id: config.id.trim(),
              prompt: config.prompt.trim(),
              dependsOn: Array.isArray(config.dependsOn) ? config.dependsOn.map((d: any) => String(d).trim()) : [],
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
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/prompt-features/extract — extract prompt features from a task text
// Dedup: returns cached extraction if taskTextHash matches, unless ?force=true
app.post("/api/v1/prompt-features/extract", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { taskText, model } = req.body;
    const force = req.query.force === "true";
    if (!taskText || typeof taskText !== "string" || !taskText.trim()) {
      return res.status(400).json({ error: "Body must contain a non-empty 'taskText' string" });
    }

    const trimmedTask = taskText.trim();
    const taskTextHash = createHash("sha256").update(trimmedTask).digest("hex");

    // Check cache (dedup by task text hash)
    if (!force) {
      const cached = await promptFeatureExtractionCollection.findOne({ taskTextHash });
      if (cached) {
        return res.json({ ...cached, cached: true });
      }
    }

    if (!isPromptFeatureLlmAvailable()) {
      return res.status(503).json({ error: "LLM not configured: GITHUB_MODELS_API_KEY is not set" });
    }

    const allFeatures = await promptFeatureCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();

    if (allFeatures.length === 0) {
      return res.status(400).json({ error: "No prompt features defined. Seed or create features first." });
    }

    const featureConfigs = allFeatures.map(f => ({ id: f.id, prompt: f.prompt, dependsOn: f.dependsOn }));
    const results = await extractPromptFeatures(trimmedTask, featureConfigs, model);

    // Store extraction result (upsert by hash for idempotency)
    const extraction: PromptFeatureExtractionDocument = {
      taskText: trimmedTask,
      taskTextHash,
      promptFeatureResults: results,
      extractedAt: new Date(),
      model: model || process.env.LLM_MODEL || "gpt-4.1",
    };

    if (force) {
      // Replace existing extraction for this hash
      await promptFeatureExtractionCollection.replaceOne(
        { taskTextHash },
        extraction,
        { upsert: true },
      );
    } else {
      await promptFeatureExtractionCollection.insertOne(extraction as any);
    }

    res.json({ ...extraction, cached: false });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not configured")) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/v1/prompt-features/extractions — list all extractions
app.get("/api/v1/prompt-features/extractions", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const extractions = await promptFeatureExtractionCollection.find({}).sort({ extractedAt: -1 }).toArray();
    res.json(extractions);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/prompt-features/extractions/:id — get a single extraction by _id
app.get("/api/v1/prompt-features/extractions/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { ObjectId } = await import("mongodb");
    let extraction;
    try {
      extraction = await promptFeatureExtractionCollection.findOne({ _id: new ObjectId(id) as any });
    } catch {
      extraction = await promptFeatureExtractionCollection.findOne({ _id: id as any });
    }
    if (!extraction) {
      return res.status(404).json({ error: "Extraction not found" });
    }
    res.json(extraction);
  } catch (error) {
    next(error);
  }
});

// List all prompt features (with optional search)
app.get("/api/v1/prompt-features", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const q = _req.query.q as string | undefined;
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
  } catch (error) {
    next(error);
  }
});

// Get prompt feature DAG graph (nodes + edges)
app.get("/api/v1/prompt-features/graph", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await promptFeatureCollection.find({ deletedAt: { $exists: false } }).toArray();
    all.sort((a, b) => a.id.localeCompare(b.id));
    const nodes = all.map(f => ({ id: f.id, prompt: f.prompt, dependsOn: f.dependsOn || [] }));
    const edges: { source: string; target: string }[] = [];
    for (const f of all) {
      if (f.dependsOn) {
        for (const parentId of f.dependsOn) {
          edges.push({ source: parentId, target: f.id });
        }
      }
    }
    res.json({ nodes, edges });
  } catch (error) {
    next(error);
  }
});

// Get single prompt feature by ID
app.get("/api/v1/prompt-features/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const feature = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!feature) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    const dependents = await promptFeatureCollection.find({
      dependsOn: id,
      deletedAt: { $exists: false },
    }).toArray();

    res.json({
      ...feature,
      dependents: dependents.map(d => d.id),
    });
  } catch (error) {
    next(error);
  }
});

// Create a new prompt feature
app.post("/api/v1/prompt-features", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, prompt, dependsOn = [] } = req.body;

    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required and must be a string" });
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: "id must match [a-z0-9_-]+" });
      return;
    }
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "prompt is required and must be a string" });
      return;
    }
    if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === "string")) {
      res.status(400).json({ error: "dependsOn must be an array of strings" });
      return;
    }

    const existing = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      res.status(409).json({ error: `Prompt feature '${id}' already exists` });
      return;
    }

    for (const depId of dependsOn) {
      const dep = await promptFeatureCollection.findOne({ id: depId, deletedAt: { $exists: false } });
      if (!dep) {
        res.status(400).json({ error: `Dependency '${depId}' does not exist` });
        return;
      }
    }

    const doc: PromptFeatureDocument = {
      id,
      prompt: prompt.trim(),
      dependsOn,
      createdAt: new Date(),
    };

    await promptFeatureCollection.insertOne(doc as any);
    res.status(201).json(doc);
  } catch (error) {
    next(error);
  }
});

// Update a prompt feature
app.put("/api/v1/prompt-features/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { prompt, dependsOn } = req.body;

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
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === "string")) {
        res.status(400).json({ error: "dependsOn must be an array of strings" });
        return;
      }
      for (const depId of dependsOn) {
        const dep = await promptFeatureCollection.findOne({ id: depId, deletedAt: { $exists: false } });
        if (!dep) {
          res.status(400).json({ error: `Dependency '${depId}' does not exist` });
          return;
        }
      }
      if (dependsOn.includes(id)) {
        res.status(400).json({ error: "A prompt feature cannot depend on itself" });
        return;
      }
      update.dependsOn = dependsOn;
    }

    await promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    const updated = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Delete a prompt feature (soft-delete, rejects if has dependents)
app.delete("/api/v1/prompt-features/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const existing = await promptFeatureCollection.findOne({ id, deletedAt: { $exists: false } });
    if (!existing) {
      res.status(404).json({ error: `Prompt feature '${id}' not found` });
      return;
    }

    const dependents = await promptFeatureCollection.find({
      dependsOn: id,
      deletedAt: { $exists: false },
    }).toArray();

    if (dependents.length > 0) {
      res.status(409).json({
        error: `Cannot delete '${id}': other prompt features depend on it`,
        dependents: dependents.map(d => d.id),
      });
      return;
    }

    await promptFeatureCollection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    res.json({ id, deleted: true });
  } catch (error) {
    next(error);
  }
});

// ==================== Report Endpoints ====================

// Create a report for a run (POST /api/v1/reports)
app.post("/api/v1/reports", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { requestId } = req.body;

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

    const reportId = uuidv4();

    const reportDoc: ReportDocument = {
      _id: reportId,
      requestId,
      status: "pending",
      logs: [],
      createdAt: new Date(),
    };

    await reportCollection.insertOne(reportDoc);

    // Queue the report for processing
    const messageContent = Buffer.from(JSON.stringify({ reportId })).toString("base64");
    await reportQueueClient.sendMessage(messageContent);

    console.log(`Created report ${reportId} for run ${requestId} and queued for processing`);

    res.status(201).json({
      id: reportId,
      requestId,
      status: "pending",
      message: "Report generation queued",
    });
  } catch (error) {
    next(error);
  }
});

// List all reports (GET /api/v1/reports)
app.get("/api/v1/reports", async (req: Request, res: Response, next: NextFunction) => {
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

    res.json(reports.map(r => ({ ...r, id: r._id })));
  } catch (error) {
    next(error);
  }
});

// Bulk report status (POST /api/v1/reports/bulk-status)
app.post("/api/v1/reports/bulk-status", async (req: Request, res: Response, next: NextFunction) => {
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
});

// Get a single report (GET /api/v1/reports/:id)
app.get("/api/v1/reports/:id", async (req: Request, res: Response, next: NextFunction) => {
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
});

// Stream report logs via SSE (GET /api/v1/reports/:id/logs)
app.get("/api/v1/reports/:id/logs", async (req: Request, res: Response, next: NextFunction) => {
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
});

// Get reports for a specific run (GET /api/v1/requests/:id/reports)
app.get("/api/v1/requests/:id/reports", async (req: Request, res: Response, next: NextFunction) => {
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
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

async function main(): Promise<void> {
  await initializeClients();

  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
