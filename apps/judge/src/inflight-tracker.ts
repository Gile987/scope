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
 * Minimal ioredis surface the tracker needs. Declaring it explicitly (rather
 * than depending on the whole ioredis type) keeps the tracker easy to unit-test
 * with an injected fake.
 *
 * **Cluster-safety:** every operation targets the single key {@link INFLIGHT_KEY}.
 * Single-key commands always route to their owning hash slot, so the tracker
 * never issues a cross-slot (`CROSSSLOT`) command and is correct on a clustered
 * Redis (Azure Cache for Redis Enterprise clustering policy) as well as a
 * standalone one — exactly like every other Redis client in this repo, none of
 * which use a cluster-mode client. Cross-slot hazards only arise with multi-key
 * commands (e.g. `MGET`), which we do not use here (cf. `clusterSafeMget`,
 * issue #1064).
 */
export interface InflightRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number, max: number): Promise<unknown>;
  zcard(key: string): Promise<number>;
  quit(): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface InflightTrackerOptions {
  /**
   * Overrides `JUDGE_MAX_EVAL_AGE_MS`. Markers older than this are pruned on
   * read, so a request that crashed before {@link InflightTracker.end} can't
   * leak an in-flight count forever.
   */
  maxEvalAgeMs?: number;
}

/** Resolve the prune window from an explicit override, then env, then the default. */
function resolveMaxEvalAgeMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const parsed = parseInt(process.env.JUDGE_MAX_EVAL_AGE_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVAL_AGE_MS;
}

/**
 * Tracks in-flight judge evaluations in Redis so the KEDA `metrics-api` scaler
 * can scale the judge on TRUE, cluster-wide concurrency. The judge is called
 * mid-run by every coder worker AND by the post-processor — both hit
 * `POST /api/v1/evaluate` — and Redis makes the count global across judge
 * replicas.
 *
 * Every Redis call is best-effort: failures never propagate to the evaluation
 * path, and {@link InflightTracker.load} fails safe to `0` so the scaler holds
 * at its minimum replica count. When constructed without a client (Redis not
 * configured) the tracker no-ops. Stale markers (a request that crashed before
 * {@link InflightTracker.end}) are pruned on read, so the count is leak-safe.
 *
 * Use {@link InflightTracker.fromEnv} in production; inject a client directly in
 * tests.
 */
export class InflightTracker {
  private readonly redis: InflightRedis | null;
  private readonly maxEvalAgeMs: number;
  private errorLogged = false;

  /**
   * @param redis   A connected/connecting Redis client, or `null` to disable
   *   tracking (every method then no-ops / fails safe).
   * @param options Optional overrides (e.g. the prune window).
   */
  constructor(redis: InflightRedis | null, options: InflightTrackerOptions = {}) {
    this.redis = redis;
    this.maxEvalAgeMs = resolveMaxEvalAgeMs(options.maxEvalAgeMs);

    if (this.redis) {
      // Swallow connection errors so ioredis doesn't emit "Unhandled error event".
      this.redis.on("error", (err: Error) => {
        if (!this.errorLogged) {
          console.error(`[judge] in-flight tracker Redis error: ${err.message}`);
          this.errorLogged = true;
        }
      });
    }
  }

  /**
   * Build a tracker from the standard `REDIS_*` environment, using the same
   * standalone-client connection config (including TLS inference) as the repo's
   * other Redis clients (see {@link ../logging/log-publisher}). No-ops when
   * `REDIS_HOST` is unset.
   */
  static fromEnv(options: InflightTrackerOptions = {}): InflightTracker {
    const redisHost = process.env.REDIS_HOST || "";
    if (!redisHost) {
      // Redis not configured — tracker no-ops and /scaler/load reports 0.
      console.log("[judge] Redis not configured — in-flight scaler load will report 0");
      return new InflightTracker(null, options);
    }

    const redisPort = parseInt(process.env.REDIS_PORT || "6300", 10);
    const redisPassword = process.env.REDIS_PASSWORD || "";
    // Canonical TLS inference shared across the repo's Redis clients: an explicit
    // REDIS_TLS wins, else infer from a password on a non-local host (Azure Cache
    // for Redis requires TLS; local/dev Redis does not).
    const useTls =
      process.env.REDIS_TLS === "true" ||
      Boolean(
        redisPassword &&
          redisHost !== "localhost" &&
          redisHost !== "127.0.0.1" &&
          redisHost !== "redis",
      );

    const client = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      // Fail commands fast rather than queueing them while disconnected — this
      // sits on the evaluation hot path and must never add latency when Redis is
      // unavailable. A missed marker only slightly undercounts; pruning and the
      // fail-safe load() keep the scaler correct.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 1000, 3000)),
    });

    console.log(`[judge] in-flight tracker connected to Redis ${redisHost}:${redisPort}`);
    return new InflightTracker(client, options);
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
   * `maxEvalAgeMs`. Fails safe to `0` when Redis is unavailable.
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
