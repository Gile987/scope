// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
import { randomUUID } from "crypto";

const require = createRequire(import.meta.url);
const Redis = require("ioredis");

/** Redis sorted set holding one member per in-flight evaluation, scored by start time (epoch ms). */
const INFLIGHT_KEY = "judge:inflight";

/** Default upper bound on a single evaluation's lifetime; stale markers older than this are pruned. */
const DEFAULT_MAX_EVAL_AGE_MS = 15 * 60 * 1000;

/**
 * Tracks in-flight judge evaluations in Redis so the KEDA `metrics-api` scaler
 * can scale the judge on TRUE, cluster-wide concurrency. The judge is called
 * mid-run by every coder worker AND by the post-processor — both hit
 * `POST /api/v1/evaluate` — and Redis makes the count global across judge
 * replicas.
 *
 * Every Redis call is best-effort: failures never propagate to the evaluation
 * path, and {@link InflightTracker.load} fails safe to `0` so the scaler holds
 * at its minimum replica count. If `REDIS_HOST` is unset the tracker no-ops.
 * Stale markers (a request that crashed before {@link InflightTracker.end}) are
 * pruned on read, so the count is leak-safe.
 */
export class InflightTracker {
  private readonly redis: InstanceType<typeof Redis> | null;
  private readonly maxEvalAgeMs: number;
  private errorLogged = false;

  constructor() {
    const redisHost = process.env.REDIS_HOST || "";
    const redisPort = parseInt(process.env.REDIS_PORT || "6300", 10);
    const redisPassword = process.env.REDIS_PASSWORD || "";
    this.maxEvalAgeMs = parseInt(
      process.env.JUDGE_MAX_EVAL_AGE_MS || String(DEFAULT_MAX_EVAL_AGE_MS),
      10,
    );

    if (!redisHost) {
      // Redis not configured — tracker no-ops and /scaler/load reports 0.
      this.redis = null;
      console.log("[judge] Redis not configured — in-flight scaler load will report 0");
      return;
    }

    // Azure Redis uses TLS on a non-6379 port; local Redis (6379) does not.
    const useTls = Boolean(redisPassword) && redisPort !== 6379;
    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      // Fail commands fast rather than queueing them while disconnected — this
      // sits on the evaluation hot path and must never add latency when Redis
      // is unavailable. A missed marker only slightly undercounts; pruning and
      // the fail-safe load() keep the scaler correct.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 1000, 3000)),
    });

    // Swallow connection errors so ioredis doesn't emit "Unhandled error event".
    this.redis.on("error", (err: Error) => {
      if (!this.errorLogged) {
        console.error(`[judge] in-flight tracker Redis error: ${err.message}`);
        this.errorLogged = true;
      }
    });

    console.log(`[judge] in-flight tracker connected to Redis ${redisHost}:${redisPort}`);
  }

  /**
   * Record a new in-flight evaluation. Returns an opaque id to pass to
   * {@link InflightTracker.end}, or `null` if tracking is disabled/unavailable
   * (callers can pass the null through to `end()`, which no-ops).
   */
  async begin(): Promise<string | null> {
    if (!this.redis) return null;
    const id = randomUUID();
    try {
      await this.redis.zadd(INFLIGHT_KEY, Date.now(), id);
      return id;
    } catch {
      return null;
    }
  }

  /** Clear an in-flight marker. Safe to call with `null` (no-op). */
  async end(id: string | null): Promise<void> {
    if (!this.redis || !id) return;
    try {
      await this.redis.zrem(INFLIGHT_KEY, id);
    } catch {
      // Best-effort — a leaked marker is pruned by load()'s stale sweep.
    }
  }

  /**
   * Current global in-flight evaluation count, after pruning markers older than
   * `JUDGE_MAX_EVAL_AGE_MS`. Fails safe to `0` when Redis is unavailable.
   */
  async load(): Promise<number> {
    if (!this.redis) return 0;
    try {
      const cutoff = Date.now() - this.maxEvalAgeMs;
      await this.redis.zremrangebyscore(INFLIGHT_KEY, 0, cutoff);
      return await this.redis.zcard(INFLIGHT_KEY);
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }
}
