// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import multer from "multer";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { createGzip } from "zlib";
import { execSync } from "child_process";
import { join, basename } from "path";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import { pack as tarPack } from "tar-stream";
import { parse as yamlParse } from "yaml";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  BulkResubmitInputSchema,
  CreateRequestInputSchema,
  ExtensionClient,
  ListRequestsQuerySchema,
  MULTI_TURN_DEFAULTS,
  PaginatedRunGroupsResponseSchema,
  PaginatedRunsResponseSchema,
  ReportResponseSchema,
  RequestResponseSchema,
  decodeCursor,
  encodeCursor,
  parseExtensionSpec,
  resolveAgentVersion,
} from "shared";
import type { ProfileDocument, ProfileVersionDocument } from "shared";
import { apiRoute } from "../openapi/api-route.js";
import { VALID_WORKERS } from "../route-context.js";
import type {
  ExtensionDocument,
  McpServerDocument,
  RequestDocument,
  RouteContext,
  WorkerType,
} from "../route-context.js";
import { computeAnalysis } from "../analysis.js";
import type { AnalysisResponse, AnalyzableRun } from "../analysis.js";
import { parseStateKey } from "../criteria-mdp.js";
import { buildGroupingPipeline } from "../grouping.js";
import { resolveSkillSpecs } from "../utils/skill-helpers.js";
import {
  detectBundledChatFiles,
  detectBundledHarFiles,
  packRunIntoTar,
  uploadBundledChatFiles,
  uploadBundledHarFiles,
} from "../archive-har.js";
import { subscribeClient, unsubscribeClient } from "../utils/sse.js";
import type { SSEClient } from "../utils/sse.js";

/**
 * Build an archive view of a request that exposes per-attempt fields
 * (turns/harUrl/rawChatUrl) at the top level. Archive packing only
 * includes the *current* run (not history), so we project run.* into
 * the shape that ArchivableRun expects, falling back to legacy top-level
 * fields for any doc the migration hasn't reshaped.
 */
function runForArchive<T extends RequestDocument>(resource: T): T {
  return {
    ...resource,
    harUrl: resource.run?.harUrl ?? resource.harUrl,
    rawChatUrl: resource.run?.rawChatUrl ?? resource.rawChatUrl,
    turns: resource.run?.turns ?? resource.turns,
  };
}

export function registerRequestsRoutes(ctx: RouteContext): void {

const upload = multer({ dest: tmpdir() });

interface QueueMessage {
  requestId: string;
  /**
   * The run id (attempt id) this message targets. Workers must verify this
   * matches `request.run._id` before processing — otherwise the message is
   * stale (a retry has since started a new attempt) and should be discarded.
   */
  runId?: string;
}

// Submit a request
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "Submit request(s)",
  body: CreateRequestInputSchema.extend({
    count: z.number().min(1).max(10).default(1),
    promptFeatureExtractionId: z.string().optional(),
    skills: z.array(z.string()).optional(),
    extensions: z.array(z.string()).optional(),
    agentVersion: z.string().optional(),
  }),
  response: z.union([RequestResponseSchema, z.array(RequestResponseSchema)]),
  successStatus: 201,
  handler: async (req, res) => {
    const { scenario: scenarioObj, persona: personaObj, maxIterations, personaInstructions, count = 1, promptFeatureExtractionId, model: requestedModel, mcpServers: mcpServerSlugs, skills: skillSlugs, extensions: extensionIds, agentVersion: requestedAgentVersion, profileId: requestedProfileId } = req.body;
    let worker = req.query.worker as string;

    // --- Profile resolution: if profileId is provided, resolve the version and use its values ---
    let profileId: string | undefined;
    let profileVersionId: string | undefined;
    let profileVersion: ProfileVersionDocument | null = null;
    if (requestedProfileId) {
      const profile = await ctx.profileCollection.findOne({
        _id: requestedProfileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${requestedProfileId}` });
        return;
      }
      profileVersion = await ctx.profileVersionCollection.findOne({
        profileId: profile._id,
        version: profile.latestVersion,
      });
      if (!profileVersion) {
        res.status(404).json({ error: `Profile version not found for profile: ${requestedProfileId}` });
        return;
      }
      profileId = profile._id;
      profileVersionId = profileVersion._id;

      // Reject requests where client-supplied fields conflict with profile values.
      // Clients should either omit these fields or send values that match the profile.
      const conflicts: string[] = [];
      if (worker && worker !== profileVersion.workerType) {
        conflicts.push(`worker: sent "${worker}", profile requires "${profileVersion.workerType}"`);
      }
      if (requestedModel && requestedModel !== profileVersion.model) {
        conflicts.push(`model: sent "${requestedModel}", profile requires "${profileVersion.model}"`);
      }
      if (mcpServerSlugs !== undefined) {
        const profileMcp = profileVersion.mcpServers ?? [];
        if (JSON.stringify([...mcpServerSlugs].sort()) !== JSON.stringify([...profileMcp].sort())) {
          conflicts.push(`mcpServers: sent ${JSON.stringify(mcpServerSlugs)}, profile requires ${JSON.stringify(profileMcp)}`);
        }
      }
      if (skillSlugs !== undefined) {
        const profileSkills = profileVersion.skillRevisions ?? [];
        if (JSON.stringify([...skillSlugs].sort()) !== JSON.stringify([...profileSkills].sort())) {
          conflicts.push(`skills: sent ${JSON.stringify(skillSlugs)}, profile requires ${JSON.stringify(profileSkills)}`);
        }
      }
      if (extensionIds !== undefined) {
        const profileExts = profileVersion.extensions ?? [];
        if (JSON.stringify([...extensionIds].sort()) !== JSON.stringify([...profileExts].sort())) {
          conflicts.push(`extensions: sent ${JSON.stringify(extensionIds)}, profile requires ${JSON.stringify(profileExts)}`);
        }
      }
      if (conflicts.length > 0) {
        res.status(400).json({
          error: `Profile "${profileId}" controls these fields. Either omit them or match the profile values.`,
          conflicts,
        });
        return;
      }

      // Profile fields take precedence
      worker = profileVersion.workerType;
    }

    // Effective values: profile overrides client inputs for controlled fields
    const effectiveModel = profileVersion ? profileVersion.model : requestedModel;
    const effectiveMcpServers = profileVersion ? (profileVersion.mcpServers ?? undefined) : mcpServerSlugs;
    const effectiveSkills = profileVersion ? (profileVersion.skillRevisions ?? undefined) : skillSlugs;
    const effectiveExtensions = profileVersion ? (profileVersion.extensions ?? undefined) : extensionIds;

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

    // At least one criterion is required — unless maxIterations is explicitly 1
    // (single-iteration mode allows running the agent without judge evaluation)
    const effectiveMaxIter = maxIterations ?? MULTI_TURN_DEFAULTS.MAX_ITERATIONS;
    if (effectiveMaxIter !== 1) {
      if (!scenarioObj.criteria || !Array.isArray(scenarioObj.criteria) || scenarioObj.criteria.length === 0) {
        res.status(400).json({ error: "At least one criterion is required in scenario.criteria when maxIterations > 1" });
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

    // Validate count if provided
    if (typeof count !== "number" || count < 1 || count > 10) {
      res.status(400).json({ error: "count must be a number between 1 and 10" });
      return;
    }

    const workerType = worker as WorkerType;

    // Resolve model: validate against agent's supportedModels if available
    let model: string | undefined = effectiveModel;
    const agentDoc = await ctx.agentCollection.findOne({ _id: workerType, deletedAt: { $exists: false } });
    if (agentDoc && agentDoc.supportedModels.length > 0) {
      if (model && !agentDoc.supportedModels.includes(model)) {
        res.status(400).json({
          error: `Invalid model "${model}" for agent "${workerType}"`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
      if (!model && agentDoc.defaultModel) {
        model = agentDoc.defaultModel;
      }
      if (!model) {
        res.status(400).json({
          error: `model is required for agent "${workerType}". Select one of supportedModels or set a defaultModel on the agent.`,
          supportedModels: agentDoc.supportedModels,
        });
        return;
      }
    }

    // Resolve agent version: explicit selection or latest active
    let resolvedAgentVersion: string | undefined;
    let versionQueueName: string | undefined;
    if (agentDoc) {
      const versionResult = resolveAgentVersion(agentDoc.versions, requestedAgentVersion);
      if ("error" in versionResult) {
        res.status(400).json({
          error: `${versionResult.error} for agent "${workerType}"`,
          activeVersions: versionResult.activeVersions,
        });
        return;
      }
      resolvedAgentVersion = versionResult.agentVersion;
      versionQueueName = versionResult.queueName;
    }

    // Validate MCP server slugs if provided
    let validatedMcpServers: string[] | undefined;
    if (effectiveMcpServers !== undefined) {
      if (!Array.isArray(effectiveMcpServers) || !effectiveMcpServers.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "mcpServers must be an array of strings (MCP server slugs)" });
        return;
      }
      if (effectiveMcpServers.length > 0) {
        const existingServers = await ctx.mcpServerCollection
          .find({ _id: { $in: effectiveMcpServers }, deletedAt: { $exists: false } })
          .toArray();
        const existingSlugs = new Set(existingServers.map((s: McpServerDocument) => s._id));
        const missingSlugs = effectiveMcpServers.filter((slug: string) => !existingSlugs.has(slug));
        if (missingSlugs.length > 0) {
          res.status(400).json({ error: `MCP server(s) not found: ${missingSlugs.join(", ")}` });
          return;
        }
        validatedMcpServers = effectiveMcpServers;
      }
    }

    // Validate and resolve skill slugs if provided
    let resolvedSkillRevisions: string[] | undefined;
    if (effectiveSkills !== undefined) {
      if (!Array.isArray(effectiveSkills) || !effectiveSkills.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "skills must be an array of strings (skill slugs)" });
        return;
      }
      if (effectiveSkills.length > 0) {
        const result = await resolveSkillSpecs(effectiveSkills, ctx);
        if (result.error) {
          const status = result.error.startsWith("Failed to resolve") ? 422 : 400;
          res.status(status).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }
    }

    // Validate extension specs if provided (supports "id" or "id@version" format)
    let validatedExtensions: string[] | undefined;
    if (effectiveExtensions !== undefined) {
      if (!Array.isArray(effectiveExtensions) || !effectiveExtensions.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({ error: "extensions must be an array of strings (extension IDs or id@version specs)" });
        return;
      }
      if (effectiveExtensions.length > 0) {
        // Parse specs to extract bare IDs for DB validation
        const parsedSpecs = effectiveExtensions.map((spec: string) => parseExtensionSpec(spec));
        const bareIds = parsedSpecs.map((s) => s.id);
        const existingExtensions = await ctx.extensionCollection
          .find({ _id: { $in: bareIds }, deletedAt: { $exists: false } })
          .toArray();
        const existingIds = new Set(existingExtensions.map((e: ExtensionDocument) => e._id));
        const missingIds = bareIds.filter((id: string) => !existingIds.has(id));
        if (missingIds.length > 0) {
          res.status(400).json({ error: `Extension(s) not found: ${missingIds.join(", ")}` });
          return;
        }

        // Resolve "latest stable" for extensions without a pinned version
        const extensionClient = new ExtensionClient("");
        const resolvedSpecs: string[] = [];
        for (const spec of parsedSpecs) {
          if (spec.version) {
            // Version already pinned
            resolvedSpecs.push(`${spec.id}@${spec.version}`);
          } else {
            // Resolve latest stable from marketplace
            const versions = await extensionClient.getVersions(spec.id, false);
            if (versions.length === 0) {
              res.status(422).json({ error: `No stable versions found for extension "${spec.id}"` });
              return;
            }
            resolvedSpecs.push(`${spec.id}@${versions[0].version}`);
          }
        }
        validatedExtensions = resolvedSpecs;
      }
    }

    // Normalize scenario: ensure criteria is always an array, preserve version
    const scenario: RequestDocument['scenario'] = {
      task: scenarioObj.task as string,
      criteria: Array.isArray(scenarioObj.criteria) ? scenarioObj.criteria as string[] : [],
      ...(scenarioObj.version === 'v1' || scenarioObj.version === 'v2' ? { version: scenarioObj.version } : {}),
    };

    const mode = scenario.criteria.length > 0 ? "multi-turn" : "one-shot";
    // Use version-specific queue if resolved, otherwise fall back to static worker queue
    const queueClient = versionQueueName
      ? ctx.getOrCreateQueueClient(versionQueueName)
      : ctx.queueClients.get(workerType)!;

    // Ensure a TaskPrompt entity exists for this task text (idempotent)
    const taskPrompt = await ctx.taskPromptStore.findOrCreate(scenario.task);
    const taskPromptId = taskPrompt._id;

    // Generate a submission ID to group all runs from this request
    const submissionId = uuidv4();

    // Handle multiple runs (count > 1)
    if (count > 1) {
      const newIds: string[] = [];
      const newDocs: RequestDocument[] = [];
      const queueMessages: string[] = [];

      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        newIds.push(requestId);

        const requestDoc: RequestDocument = {
          _id: requestId,
          scenario,
          workerType,
          taskPromptId,
          status: "pending",
          createdAt: new Date(),
          ...(model ? { model } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          ...(personaInstructions ? { personaInstructions } : {}),
          ...(personaObj ? { persona: personaObj } : {}),
          ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
          ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
          ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
          ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
          ...(profileId ? { profileId } : {}),
          ...(profileVersionId ? { profileVersionId } : {}),
          submissionId,
          // Initial attempt: run._id reuses request _id so artifact blob
          // paths ({runId}/iteration-N/...) remain stable across retries.
          run: { _id: requestId, attemptNumber: 1, status: "pending" },
          attemptCount: 1,
        };
        newDocs.push(requestDoc);

        const queueMessage: QueueMessage = { requestId, runId: requestId };
        const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
        queueMessages.push(messageContent);
      }

      // Bulk insert all documents
      await ctx.requestCollection.insertMany(newDocs);

      // Queue all messages
      for (const message of queueMessages) {
        await queueClient.sendMessage(message);
      }

      console.log(`Created ${count} ${mode} requests for ${workerType} and queued for processing`);

      res.status(201).json({
        ids: newIds,
        count,
        submissionId,
        workerType,
        taskPromptId,
        ...(model ? { model } : {}),
        ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
        status: "pending",
        mode,
        message: `${count} requests submitted successfully`,
        scenario,
        ...(maxIterations ? { maxIterations } : {}),
      });
      return;
    }

    // Single run (count === 1) - original behavior
    const requestId = uuidv4();

    // Create request document
    const requestDoc: RequestDocument = {
      _id: requestId,
      scenario,
      workerType,
      taskPromptId,
      status: "pending",
      createdAt: new Date(),
      ...(model ? { model } : {}),
      ...(maxIterations ? { maxIterations } : {}),
      ...(personaInstructions ? { personaInstructions } : {}),
      ...(personaObj ? { persona: personaObj } : {}),
      ...(promptFeatureExtractionId ? { promptFeatureExtractionId } : {}),
      ...(validatedMcpServers ? { mcpServers: validatedMcpServers } : {}),
      ...(resolvedSkillRevisions ? { skillRevisions: resolvedSkillRevisions } : {}),
      ...(validatedExtensions ? { extensions: validatedExtensions } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      ...(profileId ? { profileId } : {}),
      ...(profileVersionId ? { profileVersionId } : {}),
      submissionId,
      // Initial attempt: run._id reuses request _id so artifact blob
      // paths ({runId}/iteration-N/...) remain stable across retries.
      run: { _id: requestId, attemptNumber: 1, status: "pending" },
      attemptCount: 1,
    };

    // Store in MongoDB
    await ctx.requestCollection.insertOne(requestDoc);

    // Queue the request for the appropriate worker
    const queueMessage: QueueMessage = { requestId, runId: requestId };
    const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
    await queueClient.sendMessage(messageContent);

    console.log(`Created ${mode} request ${requestId} for ${workerType} and queued for processing`);

    res.status(201).json({
      id: requestId,
      submissionId,
      workerType,
      ...(model ? { model } : {}),
      ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
      status: requestDoc.status,
      mode,
      message: "Request submitted successfully",
      scenario,
      ...(maxIterations ? { maxIterations } : {}),
    });
  },
});

// Get request status
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Get request",
  params: z.object({ id: z.string() }),
  response: RequestResponseSchema,
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const resource = await ctx.requestCollection.findOne({ _id: id });

    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Map _id back to id for API response
    res.json({ ...resource, id: resource._id });
  },
});

// Stream logs for a request via SSE (with connection pooling)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/logs",
  tags: ["Requests"],
  summary: "Stream request logs (SSE)",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Server-sent event stream of log entries",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;
    const fromStart = req.query.fromStart === "true";

    // Verify request exists
    const resource = await ctx.requestCollection.findOne({ _id: id });

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

    // If fromStart=true, replay existing logs from blob storage
    if (fromStart) {
      try {
        const pastLogs = await ctx.blobStorage.getLogEvents(id);
        for (const log of pastLogs) {
          res.write(`data: ${JSON.stringify(log)}\n\n`);
        }
      } catch (err) {
        console.error(`Failed to replay logs for request ${id}:`, err);
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Cannot connect to log storage" })}\n\n`);
        res.end();
        return;
      }
    }

    // If request already done, send final event and close.
    // Per-attempt state lives at run.* (run-retry-attempts); fall back to
    // top-level for any in-flight legacy doc the migration hasn't reshaped.
    const currentStatus = resource.run?.status ?? resource.status;
    const currentOutcome = resource.run?.outcome ?? resource.outcome;
    const currentTurns = resource.run?.turns ?? resource.turns;
    if (currentStatus === "done") {
      // For done multi-turn requests, send turns summary
      if (currentTurns && currentTurns.length > 0) {
        res.write(`data: ${JSON.stringify({ type: "turns_summary", turns: currentTurns.length, passed: currentOutcome === "succeeded" })}\n\n`);
      }
      res.write(`event: done\ndata: ${JSON.stringify({ status: currentStatus, outcome: currentOutcome })}\n\n`);
      res.end();
      return;
    }

    // Use connection pooling - single shared subscriber
    let cleaned = false;
    let changeStream: ReturnType<typeof ctx.requestCollection.watch> | null = null;
    let redisSubscribed = false;

    // Inactivity timeout — resets every time a log message is forwarded
    const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of silence
    let inactivityTimer: ReturnType<typeof setTimeout>;

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        res.write(`event: timeout\ndata: {"message":"Stream timeout after 5 minutes of inactivity"}\n\n`);
        client.cleanup();
      }, INACTIVITY_TIMEOUT_MS);
    };

    // SSE heartbeat every 30s to prevent proxy/LB disconnects
    const heartbeat = setInterval(() => {
      if (!cleaned) {
        res.write(`:\n\n`); // SSE comment — ignored by EventSource clients
      }
    }, 30_000);

    const client: SSEClient = {
      res,
      onActivity: resetInactivityTimer,
      cleanup: () => {
        if (!cleaned) {
          cleaned = true;
          clearTimeout(inactivityTimer);
          clearInterval(heartbeat);
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

    // Start the inactivity timer
    resetInactivityTimer();

    // Try Redis subscription if configured (non-blocking - fallback to Change Streams if unavailable)
    if (process.env.REDIS_HOST) {
      try {
        await subscribeClient(id, client);
        redisSubscribed = true;
      } catch (err) {
        console.error(`Redis subscription failed for ${id}, using Change Streams only:`, err);
      }
    }

    // Use MongoDB Change Streams as fallback (or primary if Redis unavailable)
    try {
      changeStream = ctx.requestCollection.watch(
        [{ $match: { "documentKey._id": id, operationType: "update" } }],
        { fullDocument: "updateLookup" }
      );
      
      changeStream.on("change", (change) => {
        if (change.operationType === "update" && change.fullDocument) {
          const doc = change.fullDocument;
          const docStatus = doc.run?.status ?? doc.status;
          const docOutcome = doc.run?.outcome ?? doc.outcome;
          if (docStatus === "done") {
            res.write(`event: done\ndata: ${JSON.stringify({ status: docStatus, outcome: docOutcome })}\n\n`);
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
  },
});

// List all requests (excludes soft-deleted by default)
// When groupBy is provided, returns paginated RunGroup[]; otherwise paginated runs.
// Uses cursor-based pagination with `after`/`before` params.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "List requests",
  query: ListRequestsQuerySchema,
  response: z.union([PaginatedRunsResponseSchema, PaginatedRunGroupsResponseSchema]),
  handler: async (req, res) => {
    const workerFilter = req.query.worker as string;
    const taskPromptIdFilter = req.query.taskPromptId as string;
    const criteriaFilter = req.query.criteria as string;
    const submissionIdFilter = req.query.submissionId as string;
    const profileIdFilter = req.query.profileId as string;
    const statusFilter = req.query.status as string;
    const outcomeFilter = req.query.outcome as string;
    const includeDeleted = req.query.includeDeleted === "true";
    const groupByParam = req.query.groupBy as "task" | "submissionId" | "profile" | undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const afterParam = req.query.after as string | undefined;
    const beforeParam = req.query.before as string | undefined;

    if (afterParam && beforeParam) {
      res.status(400).json({ error: "Cannot specify both 'after' and 'before'" });
      return;
    }
    
    const filter: Record<string, unknown> = {};
    if (workerFilter && VALID_WORKERS.includes(workerFilter as WorkerType)) {
      filter.workerType = workerFilter;
    }
    if (taskPromptIdFilter) {
      filter.taskPromptId = taskPromptIdFilter;
    }
    if (statusFilter) {
      // Post run-retry-attempts: per-attempt state lives at run.status.
      filter["run.status"] = statusFilter;
    }
    if (outcomeFilter) {
      filter["run.outcome"] = outcomeFilter;
    }
    if (profileIdFilter) {
      filter.profileId = profileIdFilter;
    }
    if (submissionIdFilter) {
      // Prefix-based matching: allow filtering by partial submission ID
      filter.submissionId = { $regex: `^${submissionIdFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    }
    if (!includeDeleted) {
      filter.deletedAt = { $exists: false };
    }

    // Filter by MDP criteria state vector (e.g. "has_azure:0|has_cloud:1")
    // Matches runs whose LAST turn contains criteria results matching every
    // criterion in the state vector.
    if (criteriaFilter) {
      const criteriaStates = parseStateKey(criteriaFilter);
      if (criteriaStates.length > 0) {
        filter.$and = criteriaStates.map((cs) => ({
          "turns": {
            $elemMatch: {
              "criteriaResults": {
                $elemMatch: {
                  criterionId: cs.id,
                  passed: cs.passed,
                },
              },
            },
          },
        }));
      }
    }

    // O(1) estimated total from collection metadata (unfiltered)
    const estimatedTotal = await ctx.requestCollection.estimatedDocumentCount();

    // Grouped mode: paginated RunGroup[] via two-phase aggregation
    if (groupByParam) {
      const groupByField = groupByParam === "task" ? "taskPromptId" : groupByParam === "profile" ? "profileId" : "submissionId";
      const groupByAggField = `$${groupByField}`;

      // Decode group cursor
      let afterKey: string | undefined;
      let beforeKey: string | undefined;
      if (afterParam) {
        try {
          const parsed = decodeCursor(afterParam);
          if (!(groupByField in parsed)) { res.status(400).json({ error: `Invalid cursor: expected '${groupByField}' field` }); return; }
          afterKey = parsed[groupByField];
        } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
      }
      if (beforeParam) {
        try {
          const parsed = decodeCursor(beforeParam);
          if (!(groupByField in parsed)) { res.status(400).json({ error: `Invalid cursor: expected '${groupByField}' field` }); return; }
          beforeKey = parsed[groupByField];
        } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
      }

      // Phase 1: Get paginated distinct group keys + total count (lightweight)
      const keyPipeline: Record<string, unknown>[] = [
        { $match: filter },
        { $group: { _id: groupByAggField } },
        { $sort: { _id: 1 } },
      ];
      if (afterKey !== undefined) {
        keyPipeline.push({ $match: { _id: { $gt: afterKey } } });
      }
      if (beforeKey !== undefined) {
        keyPipeline.push({ $match: { _id: { $lt: beforeKey } } });
      }

      // For backward: sort descending, take limit, then reverse
      if (beforeKey !== undefined) {
        keyPipeline.push({ $sort: { _id: -1 } });
      }
      keyPipeline.push({ $limit: limit });

      const keyResults = await ctx.requestCollection.aggregate(keyPipeline).toArray();

      // Reverse results for backward pagination
      if (beforeKey !== undefined) {
        keyResults.reverse();
      }

      const pageKeys: string[] = keyResults.map((k) => k._id as string);

      if (pageKeys.length === 0) {
        res.json({ data: [], limit, estimatedTotal, cursors: { next: null, prev: null } });
        return;
      }

      // Phase 2: Full aggregation scoped to current page's groups only
      const phase2Pipeline = [
        { $match: { ...filter, [groupByField]: { $in: pageKeys } } },
        ...buildGroupingPipeline(groupByParam),
      ];
      const groups = await ctx.requestCollection.aggregate(phase2Pipeline).toArray();

      // Build cursors
      const firstKey = pageKeys[0];
      const lastKey = pageKeys[pageKeys.length - 1];

      // Check if there are more results in each direction
      const hasMoreAfter = await ctx.requestCollection.aggregate([
        { $match: filter },
        { $group: { _id: groupByAggField } },
        { $sort: { _id: 1 } },
        { $match: { _id: { $gt: lastKey } } },
        { $limit: 1 },
      ]).toArray();

      const hasMoreBefore = await ctx.requestCollection.aggregate([
        { $match: filter },
        { $group: { _id: groupByAggField } },
        { $sort: { _id: 1 } },
        { $match: { _id: { $lt: firstKey } } },
        { $limit: 1 },
      ]).toArray();

      res.json({
        data: groups,
        limit,
        estimatedTotal,
        cursors: {
          next: hasMoreAfter.length > 0 ? encodeCursor({ [groupByField]: lastKey }) : null,
          prev: hasMoreBefore.length > 0 ? encodeCursor({ [groupByField]: firstKey }) : null,
        },
      });
      return;
    }

    // Flat mode: paginated runs with cursor on { createdAt, _id }
    let afterCursor: Record<string, string> | undefined;
    let beforeCursor: Record<string, string> | undefined;
    if (afterParam) {
      try {
        afterCursor = decodeCursor(afterParam);
      } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
    }
    if (beforeParam) {
      try {
        beforeCursor = decodeCursor(beforeParam);
      } catch { res.status(400).json({ error: "Invalid cursor" }); return; }
    }

    // Build cursor filter for seek-based pagination
    const cursorFilter = { ...filter };
    let sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 };
    let needsReverse = false;

    if (afterCursor) {
      // Forward: items after this cursor (older, since sort is descending)
      cursorFilter.$or = [
        { createdAt: { $lt: new Date(afterCursor.createdAt) } },
        { createdAt: new Date(afterCursor.createdAt), _id: { $lt: afterCursor.id } },
      ];
    } else if (beforeCursor) {
      // Backward: flip sort, get items before cursor, then reverse
      sort = { createdAt: 1, _id: 1 };
      needsReverse = true;
      cursorFilter.$or = [
        { createdAt: { $gt: new Date(beforeCursor.createdAt) } },
        { createdAt: new Date(beforeCursor.createdAt), _id: { $gt: beforeCursor.id } },
      ];
    }

    const resources = await ctx.requestCollection.find(cursorFilter).sort(sort).limit(limit).toArray();

    if (needsReverse) {
      resources.reverse();
    }

    const data = resources.map((r) => ({ ...r, id: r._id }));

    if (data.length === 0) {
      res.json({ data: [], limit, estimatedTotal, cursors: { next: null, prev: null } });
      return;
    }

    // Build cursors from first and last items
    const first = data[0];
    const last = data[data.length - 1];
    const firstCreatedAt = new Date(first.createdAt).toISOString();
    const firstId = String(first._id);
    const lastCreatedAt = new Date(last.createdAt).toISOString();
    const lastId = String(last._id);

    // Check if there are more results in each direction
    const [hasMoreAfter, hasMoreBefore] = await Promise.all([
      ctx.requestCollection.find({
        ...filter,
        $or: [
          { createdAt: { $lt: new Date(lastCreatedAt) } },
          { createdAt: new Date(lastCreatedAt), _id: { $lt: lastId } },
        ],
      }).sort({ createdAt: -1, _id: -1 }).limit(1).toArray(),
      ctx.requestCollection.find({
        ...filter,
        $or: [
          { createdAt: { $gt: new Date(firstCreatedAt) } },
          { createdAt: new Date(firstCreatedAt), _id: { $gt: firstId } },
        ],
      }).sort({ createdAt: 1, _id: 1 }).limit(1).toArray(),
    ]);

    res.json({
      data,
      limit,
      estimatedTotal,
      cursors: {
        next: hasMoreAfter.length > 0 ? encodeCursor({ createdAt: lastCreatedAt, id: lastId }) : null,
        prev: hasMoreBefore.length > 0 ? encodeCursor({ createdAt: firstCreatedAt, id: firstId }) : null,
      },
    });
  },
});

// Analysis endpoint - compute pass@k, success@T, and iteration stats
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/analysis",
  tags: ["Requests"],
  summary: "Compute pass@k / success@T metrics",
  query: z.object({
    worker: z.string().optional(),
    taskPromptId: z.string().optional(),
    criteria: z.string().optional(),
    submissionId: z.string().optional(),
    k: z.string().optional(),
  }),
  response: z.object({}).passthrough().describe("Analysis metrics"),
  handler: async (req, res) => {
    // Parse k values from query string (default: 1,2,5)
    const kParam = (req.query.k as string) || "1,2,5";
    const kValues = kParam.split(",").map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v) && v > 0);

    // Parse criteria filter from query string (comma-separated criterion IDs)
    const criteriaParam = req.query.criteria as string | undefined;
    const selectedCriteria = criteriaParam
      ? criteriaParam.split(",").map(c => c.trim()).filter(Boolean)
      : undefined;

    // Fetch all done runs (exclude pending/processing, exclude deleted).
    // Per-attempt state lives at run.* (run-retry-attempts).
    const runs = await ctx.requestCollection
      .find({
        "run.status": "done",
        deletedAt: { $exists: false },
      })
      .project({
        _id: 1,
        scenario: 1,
        workerType: 1,
        run: 1,
      })
      .toArray();

    // Transform to AnalyzableRun format
    const analyzableRuns: AnalyzableRun[] = runs.map(r => ({
      scenario: r.scenario,
      workerType: r.workerType,
      status: r.run?.status ?? "done",
      outcome: r.run?.outcome,
      turns: r.run?.turns,
    }));

    const analysis: AnalysisResponse = computeAnalysis(analyzableRuns, kValues, selectedCriteria);
    res.json(analysis);
  },
});

// Bulk re-submit requests (create new runs from existing ones)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/bulk-resubmit",
  tags: ["Requests"],
  summary: "Bulk resubmit requests",
  body: BulkResubmitInputSchema,
  response: z.array(RequestResponseSchema),
  successStatus: 201,
  handler: async (req, res) => {
    const { ids, count, overrides } = req.body;

    // Validate workerType override against known workers
    if (overrides?.workerType && !VALID_WORKERS.includes(overrides.workerType as WorkerType)) {
      res.status(400).json({ error: `Invalid workerType override: ${overrides.workerType}` });
      return;
    }

    // Resolve profile override (once for the entire batch)
    let overrideProfileId: string | null | undefined = overrides?.profileId;
    let overrideProfileVersionId: string | undefined;
    let overrideProfileVersion: ProfileVersionDocument | null = null;
    if (typeof overrideProfileId === "string") {
      const profile = await ctx.profileCollection.findOne({
        _id: overrideProfileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: `Profile not found: ${overrideProfileId}` });
        return;
      }
      overrideProfileVersion = await ctx.profileVersionCollection.findOne({
        profileId: profile._id,
        version: profile.latestVersion,
      });
      if (!overrideProfileVersion) {
        res.status(404).json({ error: `Profile version not found for profile: ${overrideProfileId}` });
        return;
      }
      overrideProfileVersionId = overrideProfileVersion._id;

      // Reject individual overrides that conflict with the profile's controlled fields
      const conflicts: string[] = [];
      if (overrides?.workerType && overrides.workerType !== overrideProfileVersion.workerType) {
        conflicts.push(`workerType: sent "${overrides.workerType}", profile requires "${overrideProfileVersion.workerType}"`);
      }
      if (overrides?.model !== undefined && overrides.model !== overrideProfileVersion.model) {
        conflicts.push(`model: sent "${overrides.model}", profile requires "${overrideProfileVersion.model}"`);
      }
      if (overrides?.mcpServers !== undefined) {
        const profileMcp = overrideProfileVersion.mcpServers ?? [];
        if (JSON.stringify([...overrides.mcpServers!].sort()) !== JSON.stringify([...profileMcp].sort())) {
          conflicts.push(`mcpServers: sent ${JSON.stringify(overrides.mcpServers)}, profile requires ${JSON.stringify(profileMcp)}`);
        }
      }
      if (overrides?.skillRevisions !== undefined) {
        const profileSkills = overrideProfileVersion.skillRevisions ?? [];
        if (JSON.stringify([...overrides.skillRevisions!].sort()) !== JSON.stringify([...profileSkills].sort())) {
          conflicts.push(`skillRevisions: sent ${JSON.stringify(overrides.skillRevisions)}, profile requires ${JSON.stringify(profileSkills)}`);
        }
      }
      if (overrides?.extensions !== undefined) {
        const profileExts = overrideProfileVersion.extensions ?? [];
        if (JSON.stringify([...overrides.extensions!].sort()) !== JSON.stringify([...profileExts].sort())) {
          conflicts.push(`extensions: sent ${JSON.stringify(overrides.extensions)}, profile requires ${JSON.stringify(profileExts)}`);
        }
      }
      if (conflicts.length > 0) {
        res.status(400).json({
          error: `Profile "${overrideProfileId}" controls these fields. Either omit them or match the profile values.`,
          conflicts,
        });
        return;
      }
    }

    // Fetch original runs
    const originalRuns = await ctx.requestCollection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } }
    ).toArray();

    const foundIds = new Set(originalRuns.map(r => r._id));
    const notFound = ids.filter((id: string) => !foundIds.has(id));

    const submissionId = uuidv4();
    const newIds: string[] = [];
    const newDocs: RequestDocument[] = [];
    const queueMessages: Array<{ workerType: WorkerType; message: string }> = [];

    for (const original of originalRuns) {
      for (let i = 0; i < count; i++) {
        const requestId = uuidv4();
        newIds.push(requestId);

        // Determine effective profile for this run
        // overrideProfileId: undefined = keep original, null = detach, string = use new profile
        let effectiveProfileId: string | undefined;
        let effectiveProfileVersionId: string | undefined;
        let activeProfileVersion: ProfileVersionDocument | null = null;
        if (overrideProfileId === null) {
          // Explicitly detached — no profile
        } else if (typeof overrideProfileId === "string") {
          effectiveProfileId = overrideProfileId;
          effectiveProfileVersionId = overrideProfileVersionId;
          activeProfileVersion = overrideProfileVersion;
        } else {
          // undefined — keep from original
          effectiveProfileId = original.profileId;
          effectiveProfileVersionId = original.profileVersionId;
          // If the original had a profile, resolve its version for field overrides
          if (original.profileId && original.profileVersionId) {
            activeProfileVersion = await ctx.profileVersionCollection.findOne({ _id: original.profileVersionId });
          }
        }

        // When a profile is active, its values take precedence over individual overrides
        // for the fields it controls: workerType, model, mcpServers, skillRevisions, extensions
        const effectiveWorkerType = (activeProfileVersion
          ? activeProfileVersion.workerType
          : (overrides?.workerType ?? original.workerType)) as WorkerType;
        const effectiveModel = activeProfileVersion
          ? activeProfileVersion.model
          : (overrides?.model !== undefined ? overrides.model : original.model);
        const effectiveMaxIterations = overrides?.maxIterations !== undefined ? overrides.maxIterations : original.maxIterations;
        const effectiveMcpServers = activeProfileVersion
          ? (activeProfileVersion.mcpServers ?? null)
          : (overrides?.mcpServers !== undefined ? overrides.mcpServers : original.mcpServers);
        const effectiveSkillRevisions = activeProfileVersion
          ? (activeProfileVersion.skillRevisions ?? null)
          : (overrides?.skillRevisions !== undefined ? overrides.skillRevisions : original.skillRevisions);
        // Resolve skill specs to pinned refs (handles both bare slugs and already-pinned refs)
        let resolvedSkillRevisions: string[] | null = null;
        if (effectiveSkillRevisions && effectiveSkillRevisions.length > 0) {
          const result = await resolveSkillSpecs(effectiveSkillRevisions, ctx);
          if (result.error) {
            res.status(422).json({ error: `Skill resolution failed during resubmit: ${result.error}` });
            return;
          }
          resolvedSkillRevisions = result.refs ?? null;
        }
        const effectiveExtensions = activeProfileVersion
          ? (activeProfileVersion.extensions ?? null)
          : (overrides?.extensions !== undefined ? overrides.extensions : original.extensions);
        // Strip extensions for non-vscode workers (they don't support VS Code extensions)
        const isVscodeWorker = effectiveWorkerType.includes("vscode");

        // Resolve agent version for re-submitted run (latest active for the effective worker)
        let resolvedAgentVersion: string | undefined;
        const agentDoc = await ctx.agentCollection.findOne({ _id: effectiveWorkerType, deletedAt: { $exists: false } });
        if (agentDoc) {
          const versionResult = resolveAgentVersion(agentDoc.versions, undefined);
          if (!("error" in versionResult)) {
            resolvedAgentVersion = versionResult.agentVersion;
          }
        }

        const newDoc: RequestDocument = {
          _id: requestId,
          scenario: original.scenario,
          workerType: effectiveWorkerType,
          status: "pending",
          createdAt: new Date(),
          ...(effectiveMaxIterations ? { maxIterations: effectiveMaxIterations } : {}),
          ...(original.personaInstructions ? { personaInstructions: original.personaInstructions } : {}),
          ...(original.persona ? { persona: original.persona } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveMcpServers && effectiveMcpServers.length > 0 ? { mcpServers: effectiveMcpServers } : {}),
          ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
          ...(isVscodeWorker && effectiveExtensions && effectiveExtensions.length > 0 ? { extensions: effectiveExtensions } : {}),
          ...(resolvedAgentVersion ? { agentVersion: resolvedAgentVersion } : {}),
          ...(original.taskPromptId ? { taskPromptId: original.taskPromptId } : {}),
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(effectiveProfileVersionId ? { profileVersionId: effectiveProfileVersionId } : {}),
          submissionId,
          // Bulk re-submit creates a brand-new request — first attempt's
          // run._id reuses the new request _id (artifact paths are
          // independent of the original run).
          run: { _id: requestId, attemptNumber: 1, status: "pending" },
          attemptCount: 1,
        };

        newDocs.push(newDoc);

        const queueMessage: QueueMessage = { requestId, runId: requestId };
        const messageContent = Buffer.from(JSON.stringify(queueMessage)).toString("base64");
        queueMessages.push({ workerType: effectiveWorkerType as WorkerType, message: messageContent });
      }
    }

    // Insert all new documents
    if (newDocs.length > 0) {
      await ctx.requestCollection.insertMany(newDocs);
    }

    // Queue all messages
    for (const { workerType, message } of queueMessages) {
      const queueClient = ctx.queueClients.get(workerType);
      if (queueClient) {
        await queueClient.sendMessage(message);
      }
    }

    console.log(`Bulk re-submitted ${newIds.length} runs from ${originalRuns.length} originals (count=${count})`);

    res.status(201).json({
      submitted: newIds.length,
      failed: notFound,
      newIds,
      submissionId,
    });
  },
});

// Bulk soft-delete requests
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/requests/bulk",
  tags: ["Requests"],
  summary: "Bulk soft-delete requests",
  body: z.object({ ids: z.array(z.string()) }),
  response: z.object({ deleted: z.number() }),
  handler: async (req, res) => {
    const { ids } = req.body as { ids?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "Request body must include 'ids' array" });
      return;
    }

    // Find which IDs exist and are not already deleted
    const existingDocs = await ctx.requestCollection.find(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { projection: { _id: 1 } }
    ).toArray();
    const existingIds = new Set(existingDocs.map(d => d._id));

    // Soft-delete all matching documents
    const result = await ctx.requestCollection.updateMany(
      { _id: { $in: ids }, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    // Determine which IDs were not found or already deleted
    const notFound = ids.filter(id => !existingIds.has(id));

    res.json({
      deleted: result.modifiedCount,
      notFound,
    });
  },
});

// Soft-delete a request
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/requests/:id",
  tags: ["Requests"],
  summary: "Soft-delete request",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    const { id } = req.params;

    const result = await ctx.requestCollection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      const exists = await ctx.requestCollection.findOne({ _id: id });
      if (!exists) {
        res.status(404).json({ error: "Request not found" });
      } else {
        res.status(410).json({ error: "Request already deleted" });
      }
      return;
    }

    res.json({ id, deleted: true });
  },
});

// Download a snapshot for a specific iteration
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/snapshots/:iteration",
  tags: ["Requests"],
  summary: "Download iteration snapshot",
  params: z.object({ id: z.string(), iteration: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped snapshot archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id, iteration } = req.params;
    const iterNum = parseInt(iteration, 10);
    if (isNaN(iterNum) || iterNum < 1) {
      res.status(400).json({ error: "Invalid iteration number" });
      return;
    }

    const resource = await ctx.requestCollection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const turns = resource.run?.turns ?? resource.turns;
    const turn = turns?.find((t: Record<string, unknown>) => t.iteration === iterNum);
    if (!turn?.snapshotUrl) {
      res.status(404).json({ error: `No snapshot for iteration ${iterNum}` });
      return;
    }

    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    // Parse blob name from snapshot URL
    const snapshotUrl = new URL(turn.snapshotUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = snapshotUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid snapshot URL format" });
      return;
    }
    const blobName = snapshotUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download snapshot" });
      return;
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}-iteration-${iterNum}.tar.gz"`);
    if (downloadResponse.contentLength) {
      res.setHeader("Content-Length", downloadResponse.contentLength);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// Download a full run archive (run.yaml + iteration snapshots as .tar.gz entries)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/archive",
  tags: ["Requests"],
  summary: "Download full run archive",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped run archive",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;

    const resource = await ctx.requestCollection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    const allTurns = resource.run?.turns ?? resource.turns;
    if (!allTurns || allTurns.length === 0) {
      res.status(404).json({ error: "No iterations found for this run" });
      return;
    }

    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }
    const containerClient = blobServiceClient.getContainerClient("snapshots");

    // Set response headers before streaming
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.tar.gz"`);

    // Create streaming tar+gzip pipeline → response
    const pack = tarPack();
    const gzip = createGzip();
    pack.pipe(gzip).pipe(res);

    const isBlobNotFound = (err: unknown) =>
      err instanceof RestError && (err.statusCode === 404 || err.code === "ContainerNotFound" || err.code === "BlobNotFound");

    await packRunIntoTar(pack, runForArchive(resource), containerClient, id, isBlobNotFound);

    // Finalize the tar archive
    pack.finalize();
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
        res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
        return;
      }
      throw error;
    } else {
      // Headers already sent — destroy the response to signal an error to the client
      res.destroy();
    }
  }
  },
});

// Download a batch archive of multiple runs
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/requests/archive",
  tags: ["Requests"],
  summary: "Download batch archive of multiple runs",
  body: z.object({ ids: z.array(z.string()).min(1).max(100) }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "Gzipped batch archive containing individual run archives",
  errorResponses: {
    400: { description: "Invalid input" },
    404: { description: "One or more runs not found" },
  },
  handler: async (req, res) => {
    try {
      const { ids } = req.body;

      // Fetch all requested runs
      const runs = await ctx.requestCollection.find({ _id: { $in: ids } }).toArray();
      const foundIds = new Set(runs.map(r => r._id));
      const missingIds = ids.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        res.status(404).json({ error: "Runs not found", missingIds });
        return;
      }

      // Connect to blob storage
      let blobServiceClient: BlobServiceClient;
      if (ctx.storageConnectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
      } else {
        blobServiceClient = new BlobServiceClient(
          `https://${ctx.storageAccountName}.blob.core.windows.net`,
          new DefaultAzureCredential()
        );
      }
      const containerClient = blobServiceClient.getContainerClient("snapshots");

      // Set response headers before streaming
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="batch-${timestamp}.tar.gz"`);

      // Create streaming tar+gzip pipeline → response
      const pack = tarPack();
      const gzip = createGzip();
      pack.pipe(gzip).pipe(res);

      const isBlobNotFound = (err: unknown) =>
        err instanceof RestError && (err.statusCode === 404 || err.code === "ContainerNotFound" || err.code === "BlobNotFound");

      // Pack each run into the archive
      for (const run of runs) {
        await packRunIntoTar(pack, runForArchive(run), containerClient, run._id, isBlobNotFound);
      }

      // Finalize the tar archive
      pack.finalize();
    } catch (error) {
      if (!res.headersSent) {
        if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
          res.status(404).json({ error: "Snapshot not found — the blob may have been deleted or is no longer available" });
          return;
        }
        throw error;
      } else {
        res.destroy();
      }
    }
  },
});

// --- Runs upload (import downloaded archives) ---

// Download a HAR (HTTP Archive) file for a specific request or turn
// For one-shot runs: GET /api/v1/requests/:id/har
// For multi-turn runs: GET /api/v1/requests/:id/har?iteration=N
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/har",
  tags: ["Requests"],
  summary: "Download HAR file",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "HAR-format JSON file",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;
    const iterationParam = req.query.iteration as string | undefined;

    const resource = await ctx.requestCollection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Determine the harUrl — from a specific turn or from the top-level document
    let harUrl: string | undefined;
    let label: string;

    if (iterationParam) {
      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }
      const turns = resource.run?.turns ?? resource.turns;
      const turn = turns?.find((t: { iteration: number }) => t.iteration === iterNum);
      harUrl = turn?.harUrl;
      label = `${id}-iteration-${iterNum}`;
    } else {
      // One-shot: harUrl on run/document root; multi-turn fallback: last turn
      const turns = resource.run?.turns ?? resource.turns;
      harUrl = (resource.run?.harUrl ?? resource.harUrl) || turns?.[turns.length - 1]?.harUrl;
      label = id;
    }

    if (!harUrl) {
      res.status(404).json({ error: "No HAR capture available" });
      return;
    }

    // Connect to blob storage and proxy the HAR file
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    const parsedUrl = new URL(harUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = parsedUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid HAR URL format" });
      return;
    }
    const blobName = parsedUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download HAR file" });
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${label}.har"`);
    if (downloadResponse.contentLength) {
      res.setHeader("Content-Length", downloadResponse.contentLength);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "HAR file not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// Download a session recording video for a specific request or turn
// For one-shot runs: GET /api/v1/requests/:id/video?index=0
// For multi-turn runs: GET /api/v1/requests/:id/video?iteration=N&index=0
// For setup videos:   GET /api/v1/requests/:id/video?phase=setup&index=0
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/video",
  tags: ["Requests"],
  summary: "Download session recording",
  params: z.object({ id: z.string() }),
  response: z.any(),
  rawResponse: true,
  responseDescription: "WebM video recording (supports Range requests)",
  errorResponses: { 404: { description: "Not found" } },
  handler: async (req, res) => {
    try {
    const { id } = req.params;
    const iterationParam = req.query.iteration as string | undefined;
    const phaseParam = req.query.phase as string | undefined;
    const indexParam = req.query.index as string | undefined;
    const videoIndex = indexParam ? parseInt(indexParam, 10) : 0;

    if (isNaN(videoIndex) || videoIndex < 0) {
      res.status(400).json({ error: "Invalid video index" });
      return;
    }

    const resource = await ctx.requestCollection.findOne({ _id: id });
    if (!resource) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    // Determine the videoUrls array — from setup, a specific turn, or from the top-level document
    let videoUrls: string[] | undefined;
    let label: string;

    if (phaseParam === "setup") {
      videoUrls = resource.run?.setupVideoUrls ?? resource.setupVideoUrls;
      label = `${id}-setup-video-${videoIndex}`;
    } else if (iterationParam) {
      const iterNum = parseInt(iterationParam, 10);
      if (isNaN(iterNum) || iterNum < 1) {
        res.status(400).json({ error: "Invalid iteration number" });
        return;
      }
      const turns = resource.run?.turns ?? resource.turns;
      const turn = turns?.find((t: Record<string, unknown>) => t.iteration === iterNum);
      videoUrls = turn?.videoUrls;
      label = `${id}-iteration-${iterNum}-video-${videoIndex}`;
    } else {
      // One-shot: videoUrls on run/document root; multi-turn fallback: last turn
      const turns = resource.run?.turns ?? resource.turns;
      videoUrls = (resource.run?.videoUrls ?? resource.videoUrls) ?? turns?.[turns.length - 1]?.videoUrls;
      label = `${id}-video-${videoIndex}`;
    }

    if (!videoUrls || videoUrls.length === 0) {
      res.status(404).json({ error: "No video recordings available" });
      return;
    }

    if (videoIndex >= videoUrls.length) {
      res.status(404).json({ error: `Video index ${videoIndex} not found (${videoUrls.length} available)` });
      return;
    }

    const videoUrl = videoUrls[videoIndex];

    // Connect to blob storage and proxy the video file
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }

    const parsedUrl = new URL(videoUrl);
    const containerPrefix = "/snapshots/";
    const containerIndex = parsedUrl.pathname.indexOf(containerPrefix);
    if (containerIndex === -1) {
      res.status(500).json({ error: "Invalid video URL format" });
      return;
    }
    const blobName = parsedUrl.pathname.substring(containerIndex + containerPrefix.length);
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    const blobClient = containerClient.getBlockBlobClient(blobName);

    // Get blob properties for content length
    const properties = await blobClient.getProperties();
    const totalSize = properties.contentLength ?? 0;

    // Support HTTP Range requests for video seeking
    const rangeHeader = req.headers.range;
    if (rangeHeader && totalSize > 0) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const chunkSize = end - start + 1;

        const downloadResponse = await blobClient.download(start, chunkSize);
        if (!downloadResponse.readableStreamBody) {
          res.status(500).json({ error: "Failed to download video file" });
          return;
        }

        res.status(206);
        res.setHeader("Content-Type", "video/webm");
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", chunkSize);
        downloadResponse.readableStreamBody.pipe(res);
        return;
      }
    }

    const downloadResponse = await blobClient.download();
    if (!downloadResponse.readableStreamBody) {
      res.status(500).json({ error: "Failed to download video file" });
      return;
    }

    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", `inline; filename="${label}.webm"`);
    if (totalSize > 0) {
      res.setHeader("Content-Length", totalSize);
    }

    downloadResponse.readableStreamBody.pipe(res);
  } catch (error) {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === "ContainerNotFound" || error.code === "BlobNotFound")) {
      res.status(404).json({ error: "Video file not found — the blob may have been deleted or is no longer available" });
      return;
    }
    throw error;
  }
  },
});

// POST /api/v1/runs/upload — Upload a run archive (tar.gz) to import a previously downloaded run
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/runs/upload",
  tags: ["Requests"],
  summary: "Import run archive",
  middleware: [upload.single("archive")],
  response: RequestResponseSchema,
  rawResponse: true,
  successStatus: 201,
  handler: async (req, res) => {
  const tempDir = mkdtempSync(join(tmpdir(), "run-upload-"));
  let uploadedFilePath: string | undefined;

  try {
    // Validate file was uploaded
    if (!req.file) {
      res.status(400).json({ error: "No archive file uploaded. Use 'archive' field for the tar.gz file." });
      return;
    }
    uploadedFilePath = req.file.path;

    // Extract archive to temp directory
    const extractDir = join(tempDir, "extracted");
    execSync(`mkdir -p "${extractDir}" && tar xzf "${uploadedFilePath}" -C "${extractDir}"`, { stdio: "pipe" });

    // Find the run directory (archive contains <id>/ folder with run.yaml)
    const entries = readdirSync(extractDir);
    if (entries.length === 0) {
      res.status(400).json({ error: "Archive is empty" });
      return;
    }

    // Determine run directory - could be at root or in a subdirectory
    let runDir = extractDir;
    let runYamlPath = join(extractDir, "run.yaml");
    
    if (!existsSync(runYamlPath)) {
      // run.yaml might be inside a subdirectory (e.g., <id>/run.yaml)
      // Check each top-level entry for run.yaml
      for (const entry of entries) {
        const subDir = join(extractDir, entry);
        const subRunYaml = join(subDir, "run.yaml");
        try {
          const stat = statSync(subDir);
          if (stat.isDirectory() && existsSync(subRunYaml)) {
            runDir = subDir;
            runYamlPath = subRunYaml;
            break;
          }
        } catch {
          // Entry might not be a directory, skip
        }
      }
    }

    if (!existsSync(runYamlPath)) {
      res.status(400).json({ error: "Invalid archive: run.yaml not found" });
      return;
    }

    // Parse run.yaml
    const runYamlContent = await readFile(runYamlPath, "utf-8");
    let runDoc: RequestDocument;
    try {
      runDoc = yamlParse(runYamlContent) as RequestDocument;
    } catch (parseErr) {
      res.status(400).json({ error: `Failed to parse run.yaml: ${parseErr}` });
      return;
    }

    // Validate required fields
    if (!runDoc._id) {
      res.status(400).json({ error: "Invalid run.yaml: missing _id field" });
      return;
    }
    if (!runDoc.scenario) {
      res.status(400).json({ error: "Invalid run.yaml: missing scenario field" });
      return;
    }
    if (!runDoc.workerType) {
      res.status(400).json({ error: "Invalid run.yaml: missing workerType field" });
      return;
    }
    if (!runDoc.status) {
      res.status(400).json({ error: "Invalid run.yaml: missing status field" });
      return;
    }

    // Validate status is terminal (cannot import in-flight runs)
    const terminalStatuses = ["done"];
    if (!terminalStatuses.includes(runDoc.status)) {
      res.status(400).json({
        error: `Cannot upload in-flight run (status: ${runDoc.status}). Only terminal runs can be uploaded.`,
      });
      return;
    }

    // Check if run already exists
    const existingRun = await ctx.requestCollection.findOne({ _id: runDoc._id });
    if (existingRun) {
      res.status(409).json({
        error: `Run with ID '${runDoc._id}' already exists`,
        existingStatus: existingRun.run?.status ?? existingRun.status,
      });
      return;
    }

    // Upload iteration snapshots to blob storage and update snapshotUrls
    const turns = runDoc.turns || [];
    const iterationDirs = readdirSync(runDir).filter(name => name.startsWith("iteration-"));
    
    // Connect to blob storage
    let blobServiceClient: BlobServiceClient;
    if (ctx.storageConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
    } else {
      blobServiceClient = new BlobServiceClient(
        `https://${ctx.storageAccountName}.blob.core.windows.net`,
        new DefaultAzureCredential()
      );
    }
    const containerClient = blobServiceClient.getContainerClient("snapshots");
    await containerClient.createIfNotExists();

    for (const iterDir of iterationDirs) {
      const iterMatch = iterDir.match(/^iteration-(\d+)$/);
      if (!iterMatch) continue;
      
      const iterNum = parseInt(iterMatch[1], 10);
      const iterPath = join(runDir, iterDir);
      
      // Create tar.gz from iteration directory
      const iterArchive = join(tempDir, `iter-${iterNum}.tar.gz`);
      execSync(`tar czf "${iterArchive}" -C "${iterPath}" .`, { stdio: "pipe" });
      
      // Upload to blob storage
      const blobName = `${runDoc._id}/iteration-${iterNum}/workspace.tar.gz`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadFile(iterArchive, {
        blobHTTPHeaders: { blobContentType: "application/gzip" },
        tags: { requestId: runDoc._id, iteration: String(iterNum) },
      });
      
      // Update turn's snapshotUrl
      const turn = turns.find((t: Record<string, unknown>) => t.iteration === iterNum);
      if (turn) {
        turn.snapshotUrl = blockBlobClient.url;
      }
    }

    // Upload bundled HAR files to blob storage
    const detectedHarFiles = detectBundledHarFiles(readdirSync(runDir));
    const topLevelHarUrl = await uploadBundledHarFiles({
      harFiles: detectedHarFiles,
      runDir,
      runId: runDoc._id,
      turns,
      containerClient,
    });
    if (topLevelHarUrl) {
      runDoc.harUrl = topLevelHarUrl;
    }

    // Upload bundled chat export files to blob storage
    const detectedChatFiles = detectBundledChatFiles(readdirSync(runDir));
    const topLevelChatUrl = await uploadBundledChatFiles({
      chatFiles: detectedChatFiles,
      runDir,
      runId: runDoc._id,
      turns,
      containerClient,
    });
    if (topLevelChatUrl) {
      runDoc.rawChatUrl = topLevelChatUrl;
    }

    // Prepare document for insertion
    const docToInsert: RequestDocument = {
      _id: runDoc._id,
      scenario: runDoc.scenario,
      workerType: runDoc.workerType as WorkerType,
      status: runDoc.status,
      createdAt: runDoc.createdAt ? new Date(runDoc.createdAt) : new Date(),
      updatedAt: runDoc.updatedAt ? new Date(runDoc.updatedAt) : undefined,
      turns: turns.map((t: any) => ({
        ...t,
        timestamp: t.timestamp ? new Date(t.timestamp as string) : new Date(),
      })),
      ...(runDoc.result ? { result: runDoc.result } : {}),
      ...(runDoc.error ? { error: runDoc.error } : {}),
      ...(runDoc.maxIterations ? { maxIterations: runDoc.maxIterations } : {}),
      ...(runDoc.personaInstructions ? { personaInstructions: runDoc.personaInstructions } : {}),
      ...(runDoc.persona ? { persona: runDoc.persona } : {}),
      ...(runDoc.submissionId ? { submissionId: runDoc.submissionId } : { submissionId: uuidv4() }),
      ...(runDoc.harUrl ? { harUrl: runDoc.harUrl } : {}),
      ...(runDoc.rawChatUrl ? { rawChatUrl: runDoc.rawChatUrl } : {}),
      ...(runDoc.rawChatFormat ? { rawChatFormat: runDoc.rawChatFormat } : {}),
      // Uploaded archive represents a single (already-finished) attempt.
      // Mirror the canonical run shape so downstream code can read run.* uniformly.
      run: {
        _id: runDoc._id,
        attemptNumber: 1,
        status: runDoc.status,
        ...(runDoc.outcome ? { outcome: runDoc.outcome } : {}),
        ...(runDoc.result ? { result: runDoc.result } : {}),
        ...(runDoc.error ? { error: runDoc.error } : {}),
        ...(runDoc.harUrl ? { harUrl: runDoc.harUrl } : {}),
        ...(runDoc.rawChatUrl ? { rawChatUrl: runDoc.rawChatUrl } : {}),
        ...(runDoc.rawChatFormat ? { rawChatFormat: runDoc.rawChatFormat } : {}),
        turns: turns.map((t: any) => ({
          ...t,
          timestamp: t.timestamp ? new Date(t.timestamp as string) : new Date(),
        })),
      },
      attemptCount: 1,
    };

    // Insert into MongoDB
    await ctx.requestCollection.insertOne(docToInsert);

    console.log(`Uploaded run ${runDoc._id} with ${iterationDirs.length} iterations`);

    res.status(201).json({
      id: runDoc._id,
      status: runDoc.status,
      iterations: iterationDirs.length,
      message: "Run uploaded successfully",
    });

  } finally {
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
    if (uploadedFilePath && existsSync(uploadedFilePath)) {
      rmSync(uploadedFilePath, { force: true });
    }
  }
  },
});

apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/requests/:id/reports",
  tags: ["Reports"],
  summary: "Get reports for request",
  params: z.object({ id: z.string() }),
  response: z.array(ReportResponseSchema),
  errorResponses: {
    404: { description: "Run not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;

      // Verify the run exists
      const run = await ctx.requestCollection.findOne({ _id: id });
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      const reports = await ctx.reportCollection
        .find({ requestId: id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(reports.map(r => ({ ...r, id: r._id })));
    } catch (error) {
      next(error);
    }
  },
});

}
