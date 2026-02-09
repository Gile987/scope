// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { v4 as uuidv4 } from "uuid";
import { createRequire } from "module";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const Redis = require("ioredis");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuration from environment
// K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret
const mongoUri = process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017";
const mongoDatabase = process.env.MONGO_DATABASE || "requests-db";
const mongoCollection = process.env.MONGO_COLLECTION || "requests";
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString = process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const queueWorker1 = process.env.AZURE_STORAGE_QUEUE_WORKER_1 || "queue-coder-acp-claude-code";
const queueWorker2 = process.env.AZURE_STORAGE_QUEUE_WORKER_2 || "queue-coder-acp-copilot";
const queueWorker3 = process.env.AZURE_STORAGE_QUEUE_WORKER_3 || "queue-coder-vscode-web";
const redisHost = process.env.REDIS_HOST || "";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
const redisPassword = process.env.REDIS_PASSWORD || "";
const port = parseInt(process.env.PORT || "3000", 10);

// Valid worker types
const VALID_WORKERS = ["coder-acp-claude-code", "coder-acp-copilot", "coder-vscode-web"] as const;
type WorkerType = (typeof VALID_WORKERS)[number];

// MongoDB clients
let mongoClient: MongoClient;
let db: Db;
let collection: Collection<RequestDocument>;
const queueClients: Map<WorkerType, QueueClient> = new Map();

// Log event interface
interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown>;
}

// Request document interface
interface RequestDocument {
  _id: string;
  scenario: { task: string; criteria: string[] };
  workerType: WorkerType;
  status: "pending" | "processing" | "iterating" | "completed" | "failed";
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
}

// Queue message interface
interface QueueMessage {
  requestId: string;
}

// SSE client management for connection pooling
type SSEClient = {
  res: Response;
  cleanup: () => void;
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
  
  // Create index for createdAt (required for sorting in CosmosDB MongoDB API)
  try {
    await collection.createIndex({ createdAt: -1 });
    console.log("Created index on createdAt");
  } catch (err) {
    // Index may already exist
    console.log("Index on createdAt already exists or couldn't be created");
  }
  
  console.log(`Connected to MongoDB: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);

  // Initialize queue clients
  if (storageConnectionString) {
    // Connection string auth (local Azurite or Azure with connection string)
    queueClients.set("coder-acp-claude-code", new QueueClient(storageConnectionString, queueWorker1));
    queueClients.set("coder-acp-copilot", new QueueClient(storageConnectionString, queueWorker2));
    queueClients.set("coder-vscode-web", new QueueClient(storageConnectionString, queueWorker3));
  } else {
    // Azure with DefaultAzureCredential
    const credential = new DefaultAzureCredential();
    const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
    queueClients.set("coder-acp-claude-code", new QueueClient(`${queueUrl}/${queueWorker1}`, credential));
    queueClients.set("coder-acp-copilot", new QueueClient(`${queueUrl}/${queueWorker2}`, credential));
    queueClients.set("coder-vscode-web", new QueueClient(`${queueUrl}/${queueWorker3}`, credential));
  }

  // Ensure queues exist (creates them in Azurite on first run)
  for (const [name, client] of queueClients) {
    await client.createIfNotExists();
    console.log(`Ensured queue exists: ${name}`);
  }

  console.log(`Initialized Queue clients for workers: ${Array.from(queueClients.keys()).join(", ")}`);
}

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", version: "1.0.0" });
});

// About endpoint
app.get("/about", (_req: Request, res: Response) => {
  res.json({
    name: "Multi-Worker API (MongoDB)",
    version: "1.0.0",
    description: "API that routes requests to multiple workers via separate queues",
    workers: VALID_WORKERS,
  });
});

// Submit a request
app.post("/api/v1/requests", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions } = req.body;
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

    const workerType = worker as WorkerType;
    const requestId = uuidv4();

    // Normalize scenario: ensure criteria is always an array
    const scenario = {
      task: scenarioObj.task as string,
      criteria: Array.isArray(scenarioObj.criteria) ? scenarioObj.criteria as string[] : [],
    };

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
    };

    // Store in MongoDB
    await collection.insertOne(requestDoc);

    // Queue the request for the appropriate worker
    const queueClient = queueClients.get(workerType)!;
    const queueMessage: QueueMessage = { requestId };
    const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
    await queueClient.sendMessage(messageContent);

    const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";
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

    // If request already completed/failed, send final event and close
    if (resource.status === "completed" || resource.status === "failed") {
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
    
    const client: SSEClient = {
      res,
      cleanup: () => {
        if (!cleaned) {
          cleaned = true;
          clearTimeout(timeout);
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
          if (doc.status === "completed" || doc.status === "failed") {
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

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      res.write(`event: timeout\ndata: {"message":"Stream timeout after 5 minutes"}\n\n`);
      client.cleanup();
    }, 5 * 60 * 1000);

  } catch (error) {
    next(error);
  }
});

// List all requests
app.get("/api/v1/requests", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workerFilter = req.query.worker as string;
    
    const filter: Record<string, unknown> = {};
    if (workerFilter && VALID_WORKERS.includes(workerFilter as WorkerType)) {
      filter.workerType = workerFilter;
    }

    const resources = await collection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(resources);
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
