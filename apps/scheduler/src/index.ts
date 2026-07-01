// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";
import { RequestScheduler, WorkerTypeConfig } from "./request-scheduler.js";
import { PostProcessorDispatcher } from "./post-processor-dispatcher.js";
import { HandlerDispatcher } from "./handler-dispatcher.js";
import { createHttpServer, type NotifyHandler } from "./notify-routes.js";
import { StuckRunReaper } from "./stuck-run-reaper.js";
import { RedisHeartbeatStore, type HeartbeatStore } from "shared";
import type { RequestDocument } from "shared";

// ── Configuration ────────────────────────────────────────────────────

const MONGO_URI =
  process.env.MONGO_CONNECTION_STRING ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017";
const MONGO_DATABASE = process.env.MONGO_DATABASE || "requests-db";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "requests";

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const STORAGE_CONNECTION_STRING =
  process.env.STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONNECTION_STRING;

const POLL_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL_MS || "2000",
  10,
);
const HEALTH_PORT = parseInt(process.env.PORT || "8080", 10);
const API_URL = process.env.API_URL || "http://api:80";

/**
 * Parse a positive-integer env var with validation. Returns `fallback` (with a
 * loud warning) when the value is missing, non-numeric, non-integer, or below
 * `min`. Used for reaper safety controls where a `NaN` could otherwise disable
 * the circuit-breaker or create a tight sweep loop.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    console.warn(
      `[Scheduler] Invalid ${label}=${JSON.stringify(raw)} (need integer >= ${min}); using ${fallback}`,
    );
    return fallback;
  }
  return n;
}

// ── Stuck-run reaper config ──────────────────────────────────────────
// The reaper is the authoritative backstop that fails runs stuck in
// `processing` whose worker died without writing a terminal state. It needs
// Redis to read per-run liveness heartbeats. Redis is treated as NON-FATAL:
// if it is not configured or unreachable, the reaper self-disables while the
// dispatch loop keeps running.
//
// Disabled by default: set SCOPE_REAPER_ENABLED=true to turn it on.

const REAPER_ENABLED = process.env.SCOPE_REAPER_ENABLED === "true";
const REAPER_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.SCOPE_REAPER_POLL_INTERVAL_MS,
  60000,
  1000,
  "SCOPE_REAPER_POLL_INTERVAL_MS",
);
const REAPER_MAX_PER_SWEEP = parsePositiveInt(
  process.env.SCOPE_REAPER_MAX_PER_SWEEP,
  30,
  1,
  "SCOPE_REAPER_MAX_PER_SWEEP",
);
// Staleness threshold — kept in sync with the redelivery handler so both
// recovery paths agree on when a worker is "dead".
const RUN_HEARTBEAT_STALE_MS = parsePositiveInt(
  process.env.SCOPE_RUN_HEARTBEAT_STALE_MS,
  120000,
  1000,
  "SCOPE_RUN_HEARTBEAT_STALE_MS",
);

/**
 * Parse per-worker-type queue depth config from environment.
 * Format: SCHEDULER_QUEUE_DEPTH_<WORKER_TYPE_SCREAMING_SNAKE>=<number>
 *
 * Also reads SCHEDULER_WORKER_TYPES (comma-separated) to know which
 * worker types to schedule for.
 */
function buildWorkerTypeConfigs(): WorkerTypeConfig[] {
  const workerTypes = (
    process.env.SCHEDULER_WORKER_TYPES || "coder-acp-copilot,coder-acp-claude-code"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const configs: WorkerTypeConfig[] = [];

  for (const workerType of workerTypes) {
    // Convert worker-type to SCREAMING_SNAKE for env var lookup
    const envKey = `SCHEDULER_QUEUE_DEPTH_${workerType.replace(/-/g, "_").toUpperCase()}`;
    const targetQueueDepth = parseInt(process.env[envKey] || "5", 10);

    // Queue name follows existing convention: queue-<workerType>
    const queueName =
      process.env[`QUEUE_NAME_${workerType.replace(/-/g, "_").toUpperCase()}`] ||
      `queue-${workerType}`;

    const queueClient = createQueueClient(queueName);

    configs.push({ workerType, queueClient, targetQueueDepth });
    console.log(
      `[Scheduler] Worker type: ${workerType}, queue: ${queueName}, targetDepth: ${targetQueueDepth}`,
    );
  }

  return configs;
}

function createQueueClient(queueName: string): QueueClient {
  if (STORAGE_CONNECTION_STRING) {
    return new QueueClient(STORAGE_CONNECTION_STRING, queueName);
  }
  const credential = new DefaultAzureCredential();
  const queueUrl = `https://${STORAGE_ACCOUNT}.queue.core.windows.net/${queueName}`;
  return new QueueClient(queueUrl, credential);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[Scheduler] Starting...");
  console.log(`[Scheduler] MongoDB: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
  console.log(`[Scheduler] Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Connect to MongoDB
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  console.log("[Scheduler] Connected to MongoDB");

  const db = mongoClient.db(MONGO_DATABASE);
  const collection = db.collection<RequestDocument>(MONGO_COLLECTION);

  // Build worker type configs from environment
  const workerTypeConfigs = buildWorkerTypeConfigs();

  if (workerTypeConfigs.length === 0) {
    console.error("[Scheduler] No worker types configured. Set SCHEDULER_WORKER_TYPES.");
    process.exit(1);
  }

  // Ensure all queues exist (creates them in Azurite on first run)
  for (const wt of workerTypeConfigs) {
    await wt.queueClient.createIfNotExists();
    console.log(`[Scheduler] Ensured queue exists for ${wt.workerType}`);
  }

  // Start the scheduler
  const scheduler = new RequestScheduler(
    collection,
    workerTypeConfigs,
    POLL_INTERVAL_MS,
  );
  scheduler.start();
  console.log("[Scheduler] Dispatch loop started");

  // Start the post-processor dispatcher
  const postProcessorQueueName = process.env.QUEUE_NAME_POST_PROCESSOR || "post-processor-queue";
  const postProcessorQueueClient = createQueueClient(postProcessorQueueName);
  await postProcessorQueueClient.createIfNotExists();
  console.log(`[Scheduler] Ensured post-processor queue exists: ${postProcessorQueueName}`);

  const ppPollIntervalMs = parseInt(
    process.env.SCHEDULER_PP_POLL_INTERVAL_MS || "30000",
    10,
  );

  // Handler topology is deploy-static and invalidated on registration, so this
  // TTL only backstops out-of-band/multi-replica changes — keep it well above
  // the poll interval so the poll loop doesn't force a fresh read every cycle.
  const handlerCacheTtlMs = parseInt(
    process.env.SCHEDULER_HANDLER_CACHE_TTL_MS || "300000",
    10,
  );

  const postProcessorDispatcher = new PostProcessorDispatcher(
    collection,
    db,
    postProcessorQueueClient,
    ppPollIntervalMs,
  );
  postProcessorDispatcher.start();
  console.log("[Scheduler] Post-processor dispatch loop started");

  // Start the DAG-aware handler dispatcher (replaces legacy PostProcessorDispatcher)
  const handlerDispatcher = new HandlerDispatcher(
    collection,
    db,
    createQueueClient,
    ppPollIntervalMs,
    30,
    API_URL,
    handlerCacheTtlMs,
  );
  handlerDispatcher.start();
  console.log(
    `[Scheduler] Handler dispatcher (DAG) started (poll=${ppPollIntervalMs}ms, topologyCacheTtl=${handlerCacheTtlMs}ms)`,
  );

  // Start the stuck-run reaper (authoritative backstop). Redis is non-fatal:
  // on misconfig or connection failure the reaper self-disables (its sweeps
  // skip when ping() fails) while the dispatch loop above keeps running.
  let heartbeatStore: HeartbeatStore | null = null;
  let stuckRunReaper: StuckRunReaper | null = null;
  if (REAPER_ENABLED && process.env.REDIS_HOST) {
    try {
      heartbeatStore = new RedisHeartbeatStore({
        redisHost: process.env.REDIS_HOST || "",
        redisPort: parseInt(process.env.REDIS_PORT || "6300", 10),
        redisPassword: process.env.REDIS_PASSWORD || "",
      });
      stuckRunReaper = new StuckRunReaper(collection, heartbeatStore, {
        pollIntervalMs: REAPER_POLL_INTERVAL_MS,
        staleThresholdMs: RUN_HEARTBEAT_STALE_MS,
        maxPerSweep: REAPER_MAX_PER_SWEEP,
      });
      stuckRunReaper.start();
      console.log(
        `[Scheduler] Stuck-run reaper started (poll=${REAPER_POLL_INTERVAL_MS}ms, stale=${RUN_HEARTBEAT_STALE_MS}ms, maxPerSweep=${REAPER_MAX_PER_SWEEP})`,
      );
    } catch (err) {
      // Never let reaper setup take down the scheduler — dispatch is critical.
      console.error(
        "[Scheduler] Failed to start stuck-run reaper (continuing without it):",
        err,
      );
      stuckRunReaper = null;
      heartbeatStore = null;
    }
  } else {
    console.warn(
      `[Scheduler] Stuck-run reaper disabled (${REAPER_ENABLED ? "REDIS_HOST not set" : "SCOPE_REAPER_ENABLED not set to true"})`,
    );
  }

  // Wire notify handler to the HandlerDispatcher
  const httpServer = createHttpServer(handlerDispatcher);
  httpServer.listen(HEALTH_PORT, () => {
    console.log(`[Scheduler] HTTP server listening on :${HEALTH_PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Scheduler] Shutting down...");
    await scheduler.stop();
    await postProcessorDispatcher.stop();
    await handlerDispatcher.stop();
    if (stuckRunReaper) await stuckRunReaper.stop();
    if (heartbeatStore) await heartbeatStore.close();
    httpServer.close();
    await mongoClient.close();
    console.log("[Scheduler] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[Scheduler] Fatal error:", err);
  process.exit(1);
});
