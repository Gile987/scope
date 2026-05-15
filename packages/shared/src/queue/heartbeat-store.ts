// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Redis = require("ioredis");

import type { RedisConfig } from "../logging/log-publisher.js";

/**
 * Per-run liveness heartbeat storage.
 *
 * Workers `set` a fresh timestamp every {@link HEARTBEAT_INTERVAL_MS}
 * while a run is `processing`. The redelivery handler `get`s it to
 * decide whether a duplicate queue message represents a real worker
 * crash (stale / missing) or a spurious redelivery (fresh).
 *
 * Implementations must be tolerant of transient backend failures —
 * losing one heartbeat write must not crash the worker. Errors are
 * swallowed (and logged) by the Redis-backed implementation; tests
 * can use {@link InMemoryHeartbeatStore} to inspect calls deterministically.
 */
export interface HeartbeatStore {
  set(runId: string, ts: Date): Promise<void>;
  get(runId: string): Promise<Date | null>;
  /** Batch read for API enrichment. Missing keys are simply absent from the map. */
  mget(runIds: string[]): Promise<Map<string, Date>>;
  delete(runId: string): Promise<void>;
  close(): Promise<void>;
}

/** Default TTL is 5x the visibility timeout (60s) → 5 minutes. Configurable via env. */
export const DEFAULT_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/** Redis key prefix. Spelled out for readability when debugging via redis-cli. */
const KEY_PREFIX = "run-heartbeat:";

const keyFor = (runId: string) => `${KEY_PREFIX}${runId}`;

export interface RedisHeartbeatStoreOptions {
  ttlMs?: number;
}

export class RedisHeartbeatStore implements HeartbeatStore {
  private readonly redis: any;
  private readonly ttlMs: number;
  private warnedOnError = false;

  constructor(config: RedisConfig, options: RedisHeartbeatStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    const useTls =
      process.env.REDIS_TLS === "true" ||
      (config.redisPassword &&
        config.redisHost !== "localhost" &&
        config.redisHost !== "127.0.0.1" &&
        config.redisHost !== "redis");
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 1000, 3000)),
    });
    this.redis.on("error", (err: Error) => {
      // Throttle the warning so a sustained outage doesn't spam logs.
      if (!this.warnedOnError) {
        console.warn("[heartbeat-store] Redis error:", err.message);
        this.warnedOnError = true;
        setTimeout(() => {
          this.warnedOnError = false;
        }, 60_000);
      }
    });
  }

  async set(runId: string, ts: Date): Promise<void> {
    try {
      await this.redis.set(keyFor(runId), ts.toISOString(), "PX", this.ttlMs);
    } catch (err) {
      console.warn(`[heartbeat-store] set ${runId} failed:`, (err as Error).message);
    }
  }

  async get(runId: string): Promise<Date | null> {
    try {
      const v = await this.redis.get(keyFor(runId));
      if (!v) return null;
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? new Date(ms) : null;
    } catch (err) {
      console.warn(`[heartbeat-store] get ${runId} failed:`, (err as Error).message);
      return null;
    }
  }

  async mget(runIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (runIds.length === 0) return out;
    try {
      const vals: (string | null)[] = await this.redis.mget(runIds.map(keyFor));
      vals.forEach((v, i) => {
        if (!v) return;
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) out.set(runIds[i], new Date(ms));
      });
    } catch (err) {
      console.warn(`[heartbeat-store] mget failed:`, (err as Error).message);
    }
    return out;
  }

  async delete(runId: string): Promise<void> {
    try {
      await this.redis.del(keyFor(runId));
    } catch (err) {
      console.warn(`[heartbeat-store] delete ${runId} failed:`, (err as Error).message);
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

/**
 * In-memory implementation for tests. Honors TTL via stored expiry timestamps
 * so tests can assert TTL semantics if they care to.
 */
export class InMemoryHeartbeatStore implements HeartbeatStore {
  private readonly map = new Map<string, { ts: Date; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(options: RedisHeartbeatStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
  }

  async set(runId: string, ts: Date): Promise<void> {
    this.map.set(runId, { ts, expiresAt: Date.now() + this.ttlMs });
  }

  async get(runId: string): Promise<Date | null> {
    this.prune();
    return this.map.get(runId)?.ts ?? null;
  }

  async mget(runIds: string[]): Promise<Map<string, Date>> {
    this.prune();
    const out = new Map<string, Date>();
    for (const id of runIds) {
      const v = this.map.get(id);
      if (v) out.set(id, v.ts);
    }
    return out;
  }

  async delete(runId: string): Promise<void> {
    this.map.delete(runId);
  }

  async close(): Promise<void> {
    this.map.clear();
  }
}
