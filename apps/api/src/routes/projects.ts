// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import type { Collection } from "mongodb";
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectResponseSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

/**
 * Collections that carry a `projectId`. Used by the delete guard to decide
 * whether a project still has data filed under it. Kept in sync with the
 * scoped-collection set backfilled by migration `025-create-projects`.
 */
function scopedCollections(
  ctx: RouteContext,
): Array<{ label: string; collection: Collection<{ projectId?: string }> }> {
  return [
    { label: "requests", collection: ctx.requestCollection as unknown as Collection<{ projectId?: string }> },
    { label: "runs", collection: ctx.runsCollection as unknown as Collection<{ projectId?: string }> },
    { label: "criteria", collection: ctx.criteriaCollection as unknown as Collection<{ projectId?: string }> },
    { label: "prompt-features", collection: ctx.promptFeatureCollection as unknown as Collection<{ projectId?: string }> },
    { label: "reports", collection: ctx.reportCollection as unknown as Collection<{ projectId?: string }> },
    { label: "report-templates", collection: ctx.reportTemplateCollection as unknown as Collection<{ projectId?: string }> },
    { label: "mcp-servers", collection: ctx.mcpServerCollection as unknown as Collection<{ projectId?: string }> },
    { label: "insights", collection: ctx.insightsCollection as unknown as Collection<{ projectId?: string }> },
    { label: "task-prompts", collection: ctx.taskPromptCollection as unknown as Collection<{ projectId?: string }> },
    { label: "skills", collection: ctx.skillCollection as unknown as Collection<{ projectId?: string }> },
    { label: "extensions", collection: ctx.extensionCollection as unknown as Collection<{ projectId?: string }> },
    { label: "skill-revisions", collection: ctx.skillRevisionCollection as unknown as Collection<{ projectId?: string }> },
    { label: "profiles", collection: ctx.profileCollection as unknown as Collection<{ projectId?: string }> },
    { label: "profile-versions", collection: ctx.profileVersionCollection as unknown as Collection<{ projectId?: string }> },
    { label: "codebases", collection: ctx.codebaseCollection as unknown as Collection<{ projectId?: string }> },
    { label: "codebase-revisions", collection: ctx.codebaseRevisionCollection as unknown as Collection<{ projectId?: string }> },
  ];
}

/**
 * Return the first scoped collection that still has a document filed under
 * `projectId`, or `null` when the project is empty. Runs the per-collection
 * probes in parallel and short-circuits on the first hit.
 */
async function findScopedData(
  ctx: RouteContext,
  projectId: string,
): Promise<string | null> {
  const probes = scopedCollections(ctx).map(async ({ label, collection }) => {
    const doc = await collection.findOne(
      { projectId },
      { projection: { _id: 1 } },
    );
    return doc ? label : null;
  });
  const hits = await Promise.all(probes);
  return hits.find((h): h is string => h !== null) ?? null;
}

/**
 * Projects CRUD.
 *
 * A project is the top-level, **unscoped** container. It has no `projectId`
 * itself. Soft-delete is **blocked while the project still has data** — the
 * safest policy, so deleting a project can never strand scoped documents
 * pointing at a gone project. Callers must empty (or reassign) a project first.
 */
export function registerProjectsRoutes(ctx: RouteContext): void {
  // List all projects (newest first).
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "List all projects",
    response: z.array(ProjectResponseSchema),
    handler: async (_req, res, next) => {
      try {
        const projects = await ctx.projectStore.list();
        res.json(projects.map((p) => ({ ...p, id: p._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  // Create a project.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "Create a project",
    body: CreateProjectInputSchema,
    response: ProjectResponseSchema,
    successStatus: 201,
    errorResponses: { 400: { description: "Invalid input" } },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.create(req.body);
        res.status(201).json({ ...project, id: project._id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/name is required/i.test(message)) {
          res.status(400).json({ error: message });
          return;
        }
        next(error);
      }
    },
  });

  // Get a project by id.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Get a project",
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.get(req.params.id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...project, id: project._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Patch a project (rename / describe).
  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Update a project",
    body: UpdateProjectInputSchema,
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const updated = await ctx.projectStore.update(req.params.id, req.body);
        if (!updated) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Soft-delete a project — blocked while it still has scoped data.
  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Delete a project (only when empty)",
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: {
      404: { description: "Project not found" },
      409: { description: "Project still has data and cannot be deleted" },
    },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.get(req.params.id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        const nonEmptyIn = await findScopedData(ctx, req.params.id);
        if (nonEmptyIn) {
          res.status(409).json({
            error:
              `Project '${req.params.id}' still has data (e.g. ${nonEmptyIn}) and ` +
              `cannot be deleted. Remove or reassign its entities first.`,
          });
          return;
        }
        const ok = await ctx.projectStore.softDelete(req.params.id);
        if (!ok) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });
}
