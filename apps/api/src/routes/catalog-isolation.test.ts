// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import express from "express";
import request from "supertest";
import type { RouteContext } from "../route-context.js";
import { registerSkillsRoutes } from "./skills.js";
import { registerExtensionsRoutes } from "./extensions.js";
import { registerPromptFeaturesRoutes } from "./prompt-features.js";

extendZodWithOpenApi(z);

// ─── In-memory fake collection ───────────────────────────────────────────────
// Models the subset of the Mongo Collection API these catalog routes exercise:
// findOne (incl. $or / $exists), insertOne, updateOne ($set/$unset) and
// find().toArray(). Inserts accumulate so cross-project writes are observable.

function matches(doc: any, filter: any): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as any[]).some((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (cond && typeof cond === "object" && "$exists" in (cond as any)) {
      const has = doc[key] !== undefined;
      if ((cond as any).$exists === true && !has) return false;
      if ((cond as any).$exists === false && has) return false;
      continue;
    }
    if (doc[key] !== cond) return false;
  }
  return true;
}

function fakeCollection() {
  const docs: any[] = [];
  return {
    _docs: () => docs,
    findOne: vi.fn(async (filter: any) => docs.find((d) => matches(d, filter)) ?? null),
    insertOne: vi.fn(async (doc: any) => {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) {
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
      }
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    }),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
    find: vi.fn((filter: any = {}) => ({
      toArray: async () => docs.filter((d) => matches(d, filter)),
    })),
  } as any;
}

function buildCtx(
  register: (c: RouteContext) => void,
  over: Partial<RouteContext>,
): { app: ReturnType<typeof express>; ctx: RouteContext } {
  const app = express();
  app.use(express.json());
  const registry = new OpenAPIRegistry();

  const ctx = {
    app,
    registry,
    db: {} as any,
    // A skill resolver that succeeds without touching GitHub (POST /skills
    // auto-resolves; failures are non-fatal but we keep it clean here).
    skillResolver: { resolve: vi.fn().mockResolvedValue(undefined) } as any,
    skillRevisionStore: {} as any,
    ...over,
  } as unknown as RouteContext;

  register(ctx);

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    },
  );
  return { app, ctx };
}

// ─── skills ──────────────────────────────────────────────────────────────────

describe("skills catalog — per-project isolation (migration 026)", () => {
  it("lets the same slug be created in two projects as two distinct docs (no cross-project 409)", async () => {
    const skillCollection = fakeCollection();
    const { app } = buildCtx(registerSkillsRoutes, { skillCollection });

    const body = { source: "acme/tools", skillName: "widget", name: "Widget", origin: "manual" };

    const a = await request(app).post("/api/v1/skills?projectId=proj-a").send(body);
    const b = await request(app).post("/api/v1/skills?projectId=proj-b").send(body);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Public id stays the human slug in both projects.
    expect(a.body.id).toBe("acme/tools/widget");
    expect(b.body.id).toBe("acme/tools/widget");
    // Responses mask the internal UUID back to the slug — never leak _id.
    expect(a.body._id).toBe("acme/tools/widget");
    expect(b.body._id).toBe("acme/tools/widget");

    const rows = skillCollection._docs();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((d: any) => d.projectId))).toEqual(new Set(["proj-a", "proj-b"]));
    expect(new Set(rows.map((d: any) => d.slug))).toEqual(new Set(["acme/tools/widget"]));
    // Internal _id is a fresh UUID per copy — never the shared slug.
    expect(new Set(rows.map((d: any) => d._id)).size).toBe(2);
    for (const d of rows) expect(d._id).not.toBe(d.slug);
  });

  it("upserts (not 409) on a repeat POST of the same slug within one project", async () => {
    const skillCollection = fakeCollection();
    const { app } = buildCtx(registerSkillsRoutes, { skillCollection });
    const body = { source: "acme/tools", skillName: "widget", name: "Widget", origin: "manual" };

    const first = await request(app).post("/api/v1/skills?projectId=proj-a").send(body);
    const second = await request(app)
      .post("/api/v1/skills?projectId=proj-a")
      .send({ ...body, name: "Widget v2" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // idempotent upsert within the project
    expect(skillCollection._docs()).toHaveLength(1); // no second row
    expect(skillCollection._docs()[0].name).toBe("Widget v2");
  });

  it("scopes every create-time lookup to the request's project", async () => {
    const skillCollection = fakeCollection();
    const { app } = buildCtx(registerSkillsRoutes, { skillCollection });
    await request(app)
      .post("/api/v1/skills?projectId=proj-a")
      .send({ source: "acme/tools", skillName: "widget", name: "Widget", origin: "manual" });

    for (const [filter] of skillCollection.findOne.mock.calls) {
      expect(filter).toHaveProperty("projectId", "proj-a");
    }
  });
});

// ─── extensions ──────────────────────────────────────────────────────────────

describe("extensions catalog — per-project isolation (migration 026)", () => {
  it("lets the same slug be created in two projects as two distinct docs (no cross-project 409)", async () => {
    const extensionCollection = fakeCollection();
    const { app } = buildCtx(registerExtensionsRoutes, { extensionCollection });

    const body = { _id: "acme.widget", publisher: "acme", name: "Widget", origin: "manual" };

    const a = await request(app).post("/api/v1/extensions?projectId=proj-a").send(body);
    const b = await request(app).post("/api/v1/extensions?projectId=proj-b").send(body);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe("acme.widget");
    expect(b.body.id).toBe("acme.widget");
    // Responses mask the internal UUID back to the slug — never leak _id.
    expect(a.body._id).toBe("acme.widget");
    expect(b.body._id).toBe("acme.widget");

    const rows = extensionCollection._docs();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((d: any) => d.projectId))).toEqual(new Set(["proj-a", "proj-b"]));
    expect(new Set(rows.map((d: any) => d.slug))).toEqual(new Set(["acme.widget"]));
    expect(new Set(rows.map((d: any) => d._id)).size).toBe(2);
    for (const d of rows) expect(d._id).not.toBe(d.slug);
  });

  it("upserts (not 409) on a repeat POST of the same slug within one project", async () => {
    const extensionCollection = fakeCollection();
    const { app } = buildCtx(registerExtensionsRoutes, { extensionCollection });
    const body = { _id: "acme.widget", publisher: "acme", name: "Widget", origin: "manual" };

    const first = await request(app).post("/api/v1/extensions?projectId=proj-a").send(body);
    const second = await request(app)
      .post("/api/v1/extensions?projectId=proj-a")
      .send({ ...body, name: "Widget v2" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(extensionCollection._docs()).toHaveLength(1);
    expect(extensionCollection._docs()[0].name).toBe("Widget v2");
  });
});

// ─── prompt-features ─────────────────────────────────────────────────────────

describe("prompt-features catalog — per-project isolation (migration 026)", () => {
  it("lets the same id be created in two projects (no cross-project 409)", async () => {
    const promptFeatureCollection = fakeCollection();
    const { app } = buildCtx(registerPromptFeaturesRoutes, { promptFeatureCollection });

    const body = { id: "shared_feature", prompt: "does a thing" };

    const a = await request(app).post("/api/v1/prompt-features?projectId=proj-a").send(body);
    const b = await request(app).post("/api/v1/prompt-features?projectId=proj-b").send(body);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const rows = promptFeatureCollection._docs();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((d: any) => d.projectId))).toEqual(new Set(["proj-a", "proj-b"]));
    expect(rows.every((d: any) => d.id === "shared_feature")).toBe(true);
  });

  it("still returns 409 for a duplicate id WITHIN the same project", async () => {
    const promptFeatureCollection = fakeCollection();
    const { app } = buildCtx(registerPromptFeaturesRoutes, { promptFeatureCollection });
    const body = { id: "dup_feature", prompt: "x" };

    const first = await request(app).post("/api/v1/prompt-features?projectId=proj-a").send(body);
    const dup = await request(app).post("/api/v1/prompt-features?projectId=proj-a").send(body);
    // A different project is unaffected by proj-a's existing id.
    const other = await request(app).post("/api/v1/prompt-features?projectId=proj-b").send(body);

    expect(first.status).toBe(201);
    expect(dup.status).toBe(409);
    expect(other.status).toBe(201);
    expect(promptFeatureCollection._docs()).toHaveLength(2);
  });
});
