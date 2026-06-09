// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration tests for the StuckRunReaper (situations A2, B3, B4).
 *
 * Runs against REAL infrastructure (MongoDB + Redis), not mocks:
 *   pnpm docker:up:infra    # brings up redis + azurite + mongodb
 *   pnpm test:integration   # dotenv -e .env -- vitest --config vitest.integration.config.ts
 *
 * What the 11 unit tests already prove (with a mocked collection): the branch
 * logic — two-strikes, ping skip, circuit-breaker, claim filter shape.
 *
 * What ONLY this integration test can prove:
 *   A2  — the reaper's REAL Mongo query (`run.status:"processing"` + in-memory
 *         startedAt cutoff) actually finds a stuck run that has no queue message
 *         in existence, and the atomic findOneAndUpdate claims it on a real
 *         Mongo-compatible engine (no range index needed — CosmosDB-safe).
 *   B3  — the false-positive safety guarantee is enforced by MongoDB itself:
 *         once the reaper sets `done`, a late worker's status-gated terminal
 *         write returns matchedCount 0 and the run is NOT revived. A mock can't
 *         prove the database evaluates the filter that way.
 *   B4  — a run the worker completes between reaper strikes is never reaped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, Collection } from "mongodb";
import { RedisHeartbeatStore } from "shared";
import type { RequestDocument } from "shared";
import { StuckRunReaper } from "./stuck-run-reaper.js";

// ─── Infra coordinates (worktree-offset ports; overridable via env) ──────────
const MONGODB_PORT = Number(process.env.MONGODB_PORT) || 27028;
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6328;
const MONGO_URI = process.env.MONGO_ITEST_URI || `mongodb://127.0.0.1:${MONGODB_PORT}`;
const DB_NAME = `reaper-itest-${Date.now()}`;

const STALE_MS = 1000; // tiny threshold so the test isn't slow
const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

let mongo: MongoClient;
let collection: Collection<RequestDocument>;
let heartbeatStore: RedisHeartbeatStore;

function makeReaper(): StuckRunReaper {
  return new StuckRunReaper(collection, heartbeatStore, {
    staleThresholdMs: STALE_MS,
    maxPerSweep: 30,
    pollIntervalMs: 3_600_000, // never auto-fires; tests call sweep() directly
  });
}

async function insertRun(
  id: string,
  runId: string,
  overrides: Partial<RequestDocument["run"]> = {},
): Promise<void> {
  await collection.insertOne({
    _id: id,
    workerType: "coder-acp-copilot",
    scenario: { criteria: [], task: "x" },
    run: {
      _id: runId,
      status: "processing",
      attemptNumber: 1,
      startedAt: TEN_MIN_AGO(),
      worker: { instanceId: "worker-A" },
      ...overrides,
    },
  } as any);
}

const getRun = (id: string) =>
  collection.findOne({ _id: id } as any).then((d) => (d as any)?.run);

describe("StuckRunReaper integration (A2 / B3 / B4)", () => {
  beforeAll(async () => {
    mongo = new MongoClient(MONGO_URI);
    await mongo.connect();
    collection = mongo.db(DB_NAME).collection<RequestDocument>("requests");
    heartbeatStore = new RedisHeartbeatStore({
      redisHost: REDIS_HOST,
      redisPort: REDIS_PORT,
      redisPassword: "",
    });
  });

  afterAll(async () => {
    try { await mongo.db(DB_NAME).dropDatabase(); } catch { /* ignore */ }
    try { await mongo.close(); } catch { /* ignore */ }
    try { await heartbeatStore.close(); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await collection.deleteMany({} as any);
  });

  it("A2: reaps a stuck processing run with no heartbeat (after two strikes), sparing fresh-beat runs", async () => {
    // Stuck: old + no heartbeat → dead worker, no queue message will save it.
    await insertRun("req-stuck", "run-stuck", { worker: { instanceId: "worker-A" } });
    // Old enough to be a candidate, but its worker is ALIVE (fresh beat) →
    // proves the reaper checks the heartbeat, not just age.
    await insertRun("req-alive", "run-alive", { worker: { instanceId: "worker-B" } });
    await heartbeatStore.set("run-alive", new Date());
    // Ensure the stuck run truly has no beat.
    await heartbeatStore.delete("run-stuck");

    const reaper = makeReaper();

    // Strike 1: two-strikes means nothing is reaped on first observation.
    await reaper.sweep();
    expect((await getRun("req-stuck")).status).toBe("processing");
    expect((await getRun("req-alive")).status).toBe("processing");

    // Strike 2: the persistently-stale run is now reaped; the alive run is not.
    await reaper.sweep();
    const stuck = await getRun("req-stuck");
    expect(stuck.status).toBe("done");
    expect(stuck.outcome).toBe("failed");
    expect(stuck.error).toMatch(/Reaped by scheduler/);
    expect(stuck.finishedAt).toBeTruthy();

    const alive = await getRun("req-alive");
    expect(alive.status).toBe("processing");
    expect(alive.outcome).toBeUndefined();

    // Heartbeat key for the reaped run is cleaned up.
    expect(await heartbeatStore.get("run-stuck")).toBeNull();
  }, 30_000);

  it("B3: a late worker terminal write is a no-op after the reaper failed the run (status gate enforced by Mongo)", async () => {
    await insertRun("req-fp", "run-fp", { worker: { instanceId: "worker-A" } });
    await heartbeatStore.delete("run-fp");

    const reaper = makeReaper();
    await reaper.sweep(); // strike 1
    await reaper.sweep(); // strike 2 → reaped

    expect((await getRun("req-fp")).outcome).toBe("failed");

    // Simulate the slow-but-alive worker finally writing its terminal SUCCESS,
    // using the SAME status-gated filter the worker uses in production.
    const res = await collection.updateOne(
      { _id: "req-fp", "run._id": "run-fp", "run.status": "processing" } as any,
      { $set: { "run.status": "done", "run.outcome": "passed" } } as any,
    );

    // Mongo itself enforces the no-op: the run is no longer `processing`.
    expect(res.matchedCount).toBe(0);
    const run = await getRun("req-fp");
    expect(run.outcome).toBe("failed"); // NOT revived to "passed"
    expect(run.error).toMatch(/Reaped by scheduler/);
  }, 30_000);

  it("B4: a run the worker completes between strikes is never reaped", async () => {
    await insertRun("req-race", "run-race", { worker: { instanceId: "worker-A" } });
    await heartbeatStore.delete("run-race");

    const reaper = makeReaper();
    await reaper.sweep(); // strike 1 — observed stale, not yet reaped

    // The worker finishes successfully before the second strike.
    const res = await collection.updateOne(
      { _id: "req-race", "run._id": "run-race", "run.status": "processing" } as any,
      { $set: { "run.status": "done", "run.outcome": "passed", "run.finishedAt": new Date() } } as any,
    );
    expect(res.matchedCount).toBe(1);

    await reaper.sweep(); // strike 2 — run is no longer a candidate

    const run = await getRun("req-race");
    expect(run.status).toBe("done");
    expect(run.outcome).toBe("passed"); // reaper never touched it
    expect(run.error).toBeUndefined();
  }, 30_000);
});
