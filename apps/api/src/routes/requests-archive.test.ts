// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Round-trip + validation tests for the run import/export feature:
 *   - GET  /api/v1/requests/:id/archive   (export)
 *   - POST /api/v1/runs/upload            (import)
 *
 * Both Mongo (`ctx.requestCollection`) and Azure Blob storage are mocked
 * in-memory, so this is a pure unit test — no real services required.
 *
 * Goals:
 *   1. Round-trip: export → import → assert the re-inserted document
 *      preserves the run's identity, scenario, status, and iteration data.
 *   2. Validation: malformed archives are rejected with the right HTTP code.
 *   3. Conflict: duplicate _id returns 409 (rather than silently replacing).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { Readable } from "stream";
import { gzipSync, gunzipSync } from "zlib";
import { pack as tarPack, extract as tarExtract } from "tar-stream";
import { RestError } from "@azure/storage-blob";

extendZodWithOpenApi(z);

// ─── In-memory blob store ───────────────────────────────────────────────────
//
// Map of "<container>/<blobName>" → Buffer. The mocked
// `BlobServiceClient.fromConnectionString(...)` returns a façade that reads
// and writes through this map, so the upload handler's hard-coded
// `BlobServiceClient.fromConnectionString(...)` call is intercepted without
// touching `ctx.blobStorage` (which the handler bypasses today).

const blobStore = new Map<string, Buffer>();
const ACCOUNT_HOST = "https://test.blob.core.windows.net";

function blobUrl(container: string, name: string): string {
  return `${ACCOUNT_HOST}/${container}/${name}`;
}

function makeBlockBlobClient(container: string, name: string) {
  const key = `${container}/${name}`;
  return {
    url: blobUrl(container, name),
    async download() {
      const buf = blobStore.get(key);
      if (!buf) {
        // Mirror the @azure/storage-blob RestError shape used by the routes.
        // Routes check `err instanceof RestError` to distinguish 404s from
        // hard failures, so a plain Error would surface as a 500.
        throw new RestError(`Blob not found: ${key}`, {
          statusCode: 404,
          code: "BlobNotFound",
        });
      }
      return {
        contentLength: buf.length,
        readableStreamBody: Readable.from([buf]),
      };
    },
    async uploadFile(localPath: string) {
      // The upload handler writes the iteration tar.gz to a tmp file then
      // calls uploadFile(path). Read it from disk and stash in memory.
      const { readFileSync } = await import("fs");
      blobStore.set(key, readFileSync(localPath));
    },
    async upload(data: Buffer | string, length: number) {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      blobStore.set(key, buf.subarray(0, length));
    },
  };
}

function makeContainerClient(container: string) {
  return {
    async createIfNotExists() {
      /* no-op */
    },
    getBlockBlobClient(name: string) {
      return makeBlockBlobClient(container, name);
    },
    getBlobClient(name: string) {
      return makeBlockBlobClient(container, name);
    },
    getAppendBlobClient(name: string) {
      // BlobStorage.getLogsBlobUrl uses this just to compute a URL.
      return { url: blobUrl(container, name) };
    },
  };
}

const fakeBlobServiceClient = {
  getContainerClient(name: string) {
    return makeContainerClient(name);
  },
};

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>();
  return {
    ...actual,
    BlobServiceClient: {
      fromConnectionString: vi.fn(() => fakeBlobServiceClient),
    },
  };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

// Imports that depend on the mocked modules must come after `vi.mock`.
const { registerRequestsRoutes } = await import("./requests.js");

// ─── In-memory Mongo collection ─────────────────────────────────────────────

function makeRequestCollection() {
  const docs = new Map<string, any>();
  return {
    docs,
    findOne: vi.fn(async (filter: any) => {
      if (filter?._id) return docs.get(filter._id) ?? null;
      if (filter?._id?.$in) {
        for (const id of filter._id.$in) {
          const d = docs.get(id);
          if (d) return d;
        }
        return null;
      }
      return null;
    }),
    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc._id, doc);
      return { acknowledged: true, insertedId: doc._id };
    }),
    find: vi.fn((filter: any) => ({
      toArray: async () => {
        if (filter?._id?.$in) {
          return filter._id.$in.map((id: string) => docs.get(id)).filter(Boolean);
        }
        return Array.from(docs.values());
      },
    })),
    watch: vi.fn(),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
}

// ─── Helpers to build a tar.gz the upload handler can consume ──────────────

/** Builds a gzipped tar buffer from a flat map of entryName → content. */
async function buildTarGz(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const pack = tarPack();
  for (const [name, content] of Object.entries(entries)) {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    pack.entry({ name, size: buf.length }, buf);
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack as any) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return gzipSync(Buffer.concat(chunks));
}

/** Lists entry names + decoded contents from a tar.gz buffer. */
async function readTarGz(buf: Buffer): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const ext = tarExtract();
  const inflated = gunzipSync(buf);
  return await new Promise((resolve, reject) => {
    ext.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        out[header.name] = Buffer.concat(chunks);
        next();
      });
      stream.resume();
    });
    ext.on("finish", () => resolve(out));
    ext.on("error", reject);
    Readable.from([inflated]).pipe(ext);
  });
}

// ─── App harness ────────────────────────────────────────────────────────────

function buildApp(reqCollection: ReturnType<typeof makeRequestCollection>): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const ctx: any = {
    app,
    registry: new OpenAPIRegistry(),
    requestCollection: reqCollection,
    runsCollection: { findOne: vi.fn(), find: vi.fn(() => ({ toArray: async () => [] })) },
    // Stubs — none of these are touched by the archive/upload code paths.
    db: {} as any,
    criteriaCollection: {} as any,
    promptFeatureCollection: {} as any,
    promptFeatureExtractionCollection: {} as any,
    reportCollection: {} as any,
    reportTemplateCollection: {} as any,
    agentCollection: {} as any,
    modelCollection: {} as any,
    mcpServerCollection: {} as any,
    insightsCollection: {} as any,
    taskPromptCollection: {} as any,
    featureFlagCollection: {} as any,
    skillCollection: {} as any,
    extensionCollection: {} as any,
    skillRevisionCollection: {} as any,
    profileCollection: {} as any,
    profileVersionCollection: {} as any,
    taskPromptStore: {} as any,
    skillRevisionStore: {} as any,
    skillResolver: {} as any,
    mcpSecretClient: null,
    queueClients: new Map(),
    reportQueueClient: {} as any,
    getOrCreateQueueClient: vi.fn(),
    blobStorage: {
      getLogsBlobUrl: (name: string) => blobUrl("logs", name),
    },
    validWorkers: ["coder-acp-copilot"],
    storageConnectionString: "UseDevelopmentStorage=true",
    storageAccountName: "test",
  };

  registerRequestsRoutes(ctx);

  // Generic error handler so unhandled throws surface as 500.
  app.use((err: Error, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeFixtureRun(id = "run-fixture-1") {
  // A minimal but realistic terminal run document. Per migration 014,
  // per-attempt fields live under `run.*` (status, turns, harUrl, …).
  return {
    _id: id,
    scenario: { task: "echo hello", criteria: ["c1"] },
    workerType: "coder-acp-copilot",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    priority: 0,
    submissionId: "submission-abc",
    run: {
      _id: id,
      attemptNumber: 1,
      status: "done",
      outcome: "succeeded",
      logsUrl: blobUrl("logs", `${id}/runs/${id}/run.jsonl`),
      turns: [
        {
          iteration: 1,
          timestamp: new Date("2026-01-01T00:01:00Z"),
          snapshotUrl: blobUrl("snapshots", `${id}/iteration-1/workspace.tar.gz`),
          judgeFeedback: "looks good",
          passed: true,
        },
      ],
    },
  };
}

beforeEach(() => {
  blobStore.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("run import/export — validation (POST /api/v1/runs/upload)", () => {
  it("returns 400 when run.yaml is missing", async () => {
    const app = buildApp(makeRequestCollection());
    const archive = await buildTarGz({ "junk.txt": "no run here" });

    const res = await request(app)
      .post("/api/v1/runs/upload")
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run\.yaml/i);
  });

  it("returns 400 when run.yaml is missing _id", async () => {
    const app = buildApp(makeRequestCollection());
    const archive = await buildTarGz({
      "run/run.yaml":
        "scenario:\n  task: hi\nworkerType: coder-acp-copilot\nrun:\n  status: done\n",
    });

    const res = await request(app)
      .post("/api/v1/runs/upload")
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/_id/);
  });

  it("returns 400 for in-flight (non-terminal) runs", async () => {
    const app = buildApp(makeRequestCollection());
    const archive = await buildTarGz({
      "run/run.yaml":
        "_id: in-flight-1\nscenario:\n  task: t\n  criteria: []\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: in-flight-1\n  attemptNumber: 1\n  status: processing\n",
    });

    const res = await request(app)
      .post("/api/v1/runs/upload")
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in-flight|terminal/i);
  });

  it("returns 409 when a run with the same _id already exists", async () => {
    const reqs = makeRequestCollection();
    reqs.docs.set("dup-1", { _id: "dup-1", run: { status: "done" } });
    const app = buildApp(reqs);

    const archive = await buildTarGz({
      "dup-1/run.yaml":
        "_id: dup-1\nscenario:\n  task: t\n  criteria: []\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: dup-1\n  attemptNumber: 1\n  status: done\n",
    });

    const res = await request(app)
      .post("/api/v1/runs/upload")
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 400 with structured details when run.yaml fails schema validation", async () => {
    const app = buildApp(makeRequestCollection());

    // scenario.criteria must be string[]; sending number[] is a type
    // violation that the legacy presence checks would have missed.
    const archive = await buildTarGz({
      "bad/run.yaml":
        "_id: bad-1\nscenario:\n  task: t\n  criteria: [1, 2]\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: bad-1\n  attemptNumber: 1\n  status: done\n",
    });

    const res = await request(app)
      .post("/api/v1/runs/upload")
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run\.yaml/i);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/scenario\.criteria/) }),
      ]),
    );
  });
});

describe("run import/export — round-trip (export → import)", () => {
  it("exports a run and re-imports it preserving identity, scenario, and iterations", async () => {
    const fixture = makeFixtureRun("rt-1");

    // Source side: seed Mongo with the run, and seed blob store with the
    // iteration snapshot the export endpoint will stream into the archive.
    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(fixture._id, fixture);
    const innerIterTar = await buildTarGz({ "hello.txt": "iteration-1 contents" });
    blobStore.set(`snapshots/${fixture._id}/iteration-1/workspace.tar.gz`, innerIterTar);

    // 1. Export
    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .get(`/api/v1/requests/${fixture._id}/archive`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(exportRes.status).toBe(200);
    expect(exportRes.headers["content-type"]).toMatch(/gzip/);
    const archiveBuf: Buffer = exportRes.body;
    expect(archiveBuf.length).toBeGreaterThan(0);

    // Verify the archive layout the importer must accept.
    const entries = await readTarGz(archiveBuf);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([`${fixture._id}/run.yaml`, `${fixture._id}/iteration-1.tar.gz`]),
    );

    // 2. Import into a fresh app + Mongo. Blob store is cleared so the
    // iteration must come purely from the archive bytes.
    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);

    const importRes = await request(importApp)
      .post("/api/v1/runs/upload")
      .attach("archive", archiveBuf, "archive.tar.gz");

console.log("Import response body:", importRes.body);
    expect(importRes.status).toBe(201);
    expect(importRes.body.id).toBe(fixture._id);
    expect(importRes.body.iterations).toBe(1);

    // 3. Assert the re-inserted document mirrors the original.
    const reinserted = targetReqs.docs.get(fixture._id);
    expect(reinserted).toBeDefined();
    expect(reinserted._id).toBe(fixture._id);
    expect(reinserted.workerType).toBe(fixture.workerType);
    expect(reinserted.scenario).toEqual(fixture.scenario);
    expect(reinserted.run.status).toBe("done");
    expect(reinserted.run.outcome).toBe("succeeded");
    expect(reinserted.run.turns).toHaveLength(1);
    expect(reinserted.run.turns[0].iteration).toBe(1);
    // snapshotUrl should be rebuilt under the new run, pointing at the
    // re-uploaded iteration blob.
    expect(reinserted.run.turns[0].snapshotUrl).toMatch(
      new RegExp(`/snapshots/${fixture._id}/iteration-1/workspace\\.tar\\.gz$`),
    );
    // The iteration blob payload must have actually been re-uploaded.
    const reuploaded = blobStore.get(`snapshots/${fixture._id}/iteration-1/workspace.tar.gz`);
    expect(reuploaded).toBeDefined();
    expect(reuploaded!.length).toBeGreaterThan(0);
  });
});
