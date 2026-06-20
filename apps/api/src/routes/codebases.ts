// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import multer from "multer";
import { z } from "zod";
import {
  CreateCodebaseInputSchema,
  UpdateCodebaseInputSchema,
  ResolveCodebaseRevisionInputSchema,
  CodebaseResponseSchema,
  CodebaseRevisionResponseSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import {
  createCodebaseArchiveUploader,
  downloadCodebaseArchive,
} from "../utils/codebase-helpers.js";

export function registerCodebasesRoutes(ctx: RouteContext): void {
  const upload = multer({ dest: tmpdir() });

  const uploadArchive = createCodebaseArchiveUploader({
    storageConnectionString: ctx.storageConnectionString,
    storageAccountName: ctx.storageAccountName,
  });

  // ===================================================================
  // Codebases API
  // ===================================================================

  // List all codebases
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases",
    tags: ["Codebases"],
    summary: "List all codebases",
    response: z.array(CodebaseResponseSchema),
    handler: async (_req, res, next) => {
      try {
        const codebases = await ctx.codebaseStore.list();
        res.json(codebases.map((c) => ({ ...c, id: c._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  // Create a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases",
    tags: ["Codebases"],
    summary: "Create a codebase",
    body: CreateCodebaseInputSchema,
    response: CodebaseResponseSchema,
    successStatus: 201,
    errorResponses: {
      400: { description: "Invalid input" },
    },
    handler: async (req, res, next) => {
      try {
        const { name, slug, description, sourceType, source, defaultBranch, creator } = req.body;
        if (sourceType === "git" && (!source || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source))) {
          res.status(400).json({ error: "Git codebases require a 'source' in the form 'owner/repo'" });
          return;
        }
        const codebase = await ctx.codebaseStore.create({
          name,
          ...(slug ? { slug } : {}),
          ...(description ? { description } : {}),
          sourceType,
          ...(source ? { source } : {}),
          ...(defaultBranch ? { defaultBranch } : {}),
          ...(creator ? { creator } : {}),
        });
        res.status(201).json({ ...codebase, id: codebase._id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/slug|source/i.test(message)) {
          res.status(400).json({ error: message });
          return;
        }
        next(error);
      }
    },
  });

  // Get a codebase by id
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Get a codebase",
    response: CodebaseResponseSchema,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        res.json({ ...codebase, id: codebase._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Patch a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Update a codebase",
    body: UpdateCodebaseInputSchema,
    response: CodebaseResponseSchema,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const updated = await ctx.codebaseStore.update(req.params.id, req.body);
        if (!updated) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Soft-delete a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Delete a codebase",
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const ok = await ctx.codebaseStore.softDelete(req.params.id);
        if (!ok) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        await ctx.codebaseRevisionStore.deleteByCodebase(req.params.id);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });

  // List revisions for a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases/:id/revisions",
    tags: ["Codebases"],
    summary: "List codebase revisions",
    query: z.object({ limit: z.string().optional() }),
    response: z.array(CodebaseRevisionResponseSchema),
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        const limitStr = req.query.limit as string | undefined;
        const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10), 1), 200);
        const revisions = await ctx.codebaseRevisionStore.listByCodebase(codebase._id, { limit });
        res.json(revisions);
      } catch (error) {
        next(error);
      }
    },
  });

  // Resolve a new git revision (snapshot the repo at a ref / "latest")
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases/:id/revisions",
    tags: ["Codebases"],
    summary: "Resolve a new git codebase revision",
    body: ResolveCodebaseRevisionInputSchema,
    response: CodebaseRevisionResponseSchema,
    successStatus: 201,
    errorResponses: {
      400: { description: "Not a git codebase" },
      404: { description: "Codebase not found" },
      502: { description: "GitHub resolution failed" },
    },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        if (codebase.sourceType !== "git") {
          res.status(400).json({ error: "Only git codebases can resolve revisions; upload an archive instead" });
          return;
        }
        const { requestedRef, creator } = req.body;
        try {
          const result = await ctx.codebaseResolver.resolveGit(
            codebase,
            requestedRef,
            ctx.codebaseRevisionStore,
            uploadArchive,
            creator ? { creator } : undefined
          );
          res
            .status(result.deduplicated ? 200 : 201)
            .json({ ...result.revision, deduplicated: result.deduplicated });
        } catch (resolveError) {
          const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
          if (/not found/i.test(message)) {
            res.status(404).json({ error: message });
            return;
          }
          res.status(502).json({ error: `GitHub resolution failed: ${message}` });
        }
      } catch (error) {
        next(error);
      }
    },
  });

  // Upload an archive → create a new archive revision
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases/:id/upload",
    tags: ["Codebases"],
    summary: "Upload a codebase archive as a new revision",
    middleware: [upload.single("archive")],
    response: CodebaseRevisionResponseSchema,
    rawResponse: true,
    successStatus: 201,
    errorResponses: {
      400: { description: "Missing archive or not an archive codebase" },
      404: { description: "Codebase not found" },
    },
    handler: async (req, res, next) => {
      const file = (req as unknown as { file?: { path: string; originalname?: string } }).file;
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        if (codebase.sourceType !== "archive") {
          res.status(400).json({ error: "Only archive codebases accept uploads; resolve a git revision instead" });
          return;
        }
        if (!file?.path) {
          res.status(400).json({ error: "No archive file uploaded. Use multipart field 'archive'." });
          return;
        }
        const buffer = readFileSync(file.path);
        const creator = ((req.body as Record<string, unknown> | undefined)?.creator as string | undefined) ?? undefined;
        const result = await ctx.codebaseResolver.createArchiveRevision(
          codebase,
          {
            buffer,
            ...(file.originalname ? { originalFilename: file.originalname } : {}),
            ...(creator ? { creator } : {}),
          },
          ctx.codebaseRevisionStore,
          uploadArchive
        );
        res
          .status(result.deduplicated ? 200 : 201)
          .json({ ...result.revision, deduplicated: result.deduplicated });
      } catch (error) {
        next(error);
      } finally {
        if (file?.path && existsSync(file.path)) rmSync(file.path, { force: true });
      }
    },
  });

  // ===================================================================
  // Codebase Revisions API
  // ===================================================================

  // Download a codebase revision archive (tar.gz) — used by workers to seed
  // the workspace. MUST be registered before GET /:id to avoid wildcard capture.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebase-revisions/:id/archive",
    tags: ["Codebase Revisions"],
    summary: "Download codebase revision archive",
    response: z.any(),
    rawResponse: true,
    responseDescription: "Binary tar.gz archive",
    errorResponses: {
      404: { description: "Revision or archive not found" },
      500: { description: "Blob storage error" },
    },
    handler: async (req, res, next) => {
      try {
        const revision = await ctx.codebaseRevisionStore.get(req.params.id);
        if (!revision) {
          res.status(404).json({ error: "Codebase revision not found" });
          return;
        }
        if (!revision.archiveUrl) {
          res.status(404).json({ error: "Codebase revision has no archive" });
          return;
        }
        const buffer = await downloadCodebaseArchive(revision.archiveUrl, {
          storageConnectionString: ctx.storageConnectionString,
          storageAccountName: ctx.storageAccountName,
        });
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Disposition", `attachment; filename="${revision._id}.tar.gz"`);
        res.setHeader("Content-Length", buffer.length.toString());
        res.send(buffer);
      } catch (error) {
        next(error);
      }
    },
  });

  // Get a codebase revision by id
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebase-revisions/:id",
    tags: ["Codebase Revisions"],
    summary: "Get codebase revision by id",
    response: CodebaseRevisionResponseSchema,
    errorResponses: { 404: { description: "Revision not found" } },
    handler: async (req, res, next) => {
      try {
        const revision = await ctx.codebaseRevisionStore.get(req.params.id);
        if (!revision) {
          res.status(404).json({ error: "Codebase revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });
}
