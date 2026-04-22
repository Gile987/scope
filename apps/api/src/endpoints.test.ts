// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { app, _injectTestDependencies } from "./index.js";
import { createAllMockDependencies, createMockCollection } from "./test-helpers.js";

// Stub checkMigrations before it can be imported by index.ts
vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001", "002"],
    pending: [],
  }),
}));

// Stub LLM helpers — not testing AI generation
vi.mock("./llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generateCriteriaPrompt: vi.fn(),
}));
vi.mock("./prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generatePromptFeaturePrompt: vi.fn(),
  extractPromptFeatures: vi.fn(),
}));
vi.mock("./task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false),
  generateTaskPrompt: vi.fn(),
}));

describe("API Endpoints", () => {
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-inject after clearAllMocks so the mock implementations are fresh
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  // ===================================================================
  // Utility endpoints
  // ===================================================================

  describe("GET /health", () => {
    it("returns 200 with status healthy", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "healthy");
      expect(res.body).toHaveProperty("version");
    });
  });

  describe("GET /ready", () => {
    it("returns 200 when migrations are ready", async () => {
      const { checkMigrations } = await import("db-migrations/check-migrations");
      (checkMigrations as any).mockResolvedValue({
        ready: true,
        applied: ["001", "002"],
        pending: [],
      });

      const res = await request(app).get("/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
    });

    it("returns 503 when migrations are not ready", async () => {
      const { checkMigrations } = await import("db-migrations/check-migrations");
      (checkMigrations as any).mockResolvedValue({
        ready: false,
        applied: ["001"],
        pending: ["002"],
      });

      const res = await request(app).get("/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not-ready");
    });
  });

  describe("GET /about", () => {
    it("returns 200 with name and version", async () => {
      const res = await request(app).get("/about");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("name");
      expect(res.body).toHaveProperty("version");
      expect(res.body).toHaveProperty("workers");
    });
  });

  describe("GET /api/v1/version", () => {
    it("returns 200 with commit and build info", async () => {
      const res = await request(app).get("/api/v1/version");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("commit");
      expect(res.body).toHaveProperty("buildTime");
      expect(res.body).toHaveProperty("environment");
    });
  });

  // ===================================================================
  // Criteria endpoints
  // ===================================================================

  describe("GET /api/v1/criteria", () => {
    it("returns 200 with array of criteria", async () => {
      const mockCriteria = [{ id: "c1", prompt: "Test", dependsOn: [], createdAt: new Date() }];
      const cursor = {
        toArray: vi.fn().mockResolvedValue(mockCriteria),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      };
      (mocks.criteriaCollection.find as any).mockReturnValue(cursor);

      const res = await request(app).get("/api/v1/criteria");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/criteria", () => {
    it("returns 201 when creating a new criterion", async () => {
      // findOne returns null (no duplicate)
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/criteria")
        .send({ id: "new_crit", prompt: "Does it work?", dependsOn: [] });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new_crit");
    });

    it("returns 409 when criterion already exists", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "existing",
        prompt: "Old prompt",
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/api/v1/criteria")
        .send({ id: "existing", prompt: "Duplicate", dependsOn: [] });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/v1/criteria/:id", () => {
    it("returns 200 when criterion exists", async () => {
      const doc = { id: "c1", prompt: "Check it", dependsOn: [], createdAt: new Date() };
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(doc);
      const depCursor = { toArray: vi.fn().mockResolvedValue([]) };
      (mocks.criteriaCollection.find as any).mockReturnValue(depCursor);

      const res = await request(app).get("/api/v1/criteria/c1");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("c1");
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/criteria/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/v1/criteria/:id", () => {
    it("returns 200 when updating existing criterion", async () => {
      const existing = { id: "c1", prompt: "Old", dependsOn: [], createdAt: new Date() };
      (mocks.criteriaCollection.findOne as any)
        .mockResolvedValueOnce(existing)   // existence check
        .mockResolvedValueOnce({ ...existing, prompt: "Updated" }); // after update

      const res = await request(app)
        .put("/api/v1/criteria/c1")
        .send({ prompt: "Updated" });

      expect(res.status).toBe(200);
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .put("/api/v1/criteria/missing")
        .send({ prompt: "Nope" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/criteria/:id", () => {
    it("returns 200 when deleting criterion with no dependents", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "c1",
        prompt: "Del me",
        dependsOn: [],
        createdAt: new Date(),
      });
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const res = await request(app).delete("/api/v1/criteria/c1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("deleted", true);
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).delete("/api/v1/criteria/missing");
      expect(res.status).toBe(404);
    });

    it("returns 409 when criterion has dependents", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "c1",
        prompt: "Parent",
        dependsOn: [],
        createdAt: new Date(),
      });
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: "child" }]),
      });

      const res = await request(app).delete("/api/v1/criteria/c1");
      expect(res.status).toBe(409);
    });
  });

  // ===================================================================
  // Agents endpoints
  // ===================================================================

  describe("GET /api/v1/agents", () => {
    it("returns 200 with array of agents", async () => {
      const agents = [{ _id: "coder-acp-copilot", name: "Copilot", supportedModels: [], createdAt: new Date() }];
      (mocks.agentCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(agents),
      });

      const res = await request(app).get("/api/v1/agents");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "coder-acp-copilot");
    });
  });

  describe("POST /api/v1/agents", () => {
    it("returns 201 when creating a new agent", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/agents")
        .send({ _id: "new-agent", name: "New Agent" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new-agent");
    });

    it("returns 400 when _id missing", async () => {
      const res = await request(app)
        .post("/api/v1/agents")
        .send({ name: "No ID" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/agents/:id", () => {
    it("returns 200 when agent exists", async () => {
      const doc = { _id: "agent-1", name: "Agent One", supportedModels: [], createdAt: new Date() };
      (mocks.agentCollection.findOne as any).mockResolvedValue(doc);

      const res = await request(app).get("/api/v1/agents/agent-1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "agent-1");
    });

    it("returns 404 when agent not found", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/agents/missing");
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Models endpoints
  // ===================================================================

  describe("GET /api/v1/models", () => {
    it("returns 200 with array of models", async () => {
      const models = [{ _id: "agent:gpt-4", modelId: "gpt-4", provider: "github", agentId: "agent" }];
      (mocks.modelCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(models),
        }),
      });

      const res = await request(app).get("/api/v1/models");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===================================================================
  // Insights endpoints
  // ===================================================================

  describe("GET /api/v1/insights", () => {
    it("returns 200 with array of insights", async () => {
      const insights = [{ _id: "i1", title: "Test", description: "desc", createdAt: new Date() }];
      (mocks.insightsCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(insights),
        }),
      });

      const res = await request(app).get("/api/v1/insights");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "i1");
    });
  });

  describe("POST /api/v1/insights", () => {
    it("returns 201 when creating an insight", async () => {
      const res = await request(app)
        .post("/api/v1/insights")
        .send({ title: "New Insight", description: "Something learned" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("title", "New Insight");
      expect(res.body).toHaveProperty("id");
    });

    it("returns 400 when title missing", async () => {
      const res = await request(app)
        .post("/api/v1/insights")
        .send({ description: "No title" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/insights/:id", () => {
    it("returns 200 when insight exists", async () => {
      const doc = { _id: "i1", title: "Insight", description: "details", createdAt: new Date() };
      (mocks.insightsCollection.findOne as any).mockResolvedValue(doc);

      const res = await request(app).get("/api/v1/insights/i1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "i1");
    });

    it("returns 404 when insight not found", async () => {
      (mocks.insightsCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/insights/missing");
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Requests endpoints
  // ===================================================================

  describe("GET /api/v1/requests", () => {
    it("returns 200 with paginated response", async () => {
      const docs = [{ _id: "r1", scenario: { task: "t", criteria: [] }, workerType: "coder-acp-copilot", status: "completed", createdAt: new Date() }];
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(docs),
          }),
        }),
      });

      const res = await request(app).get("/api/v1/requests");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("limit");
      expect(res.body).toHaveProperty("estimatedTotal");
      expect(res.body).toHaveProperty("cursors");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toHaveProperty("id", "r1");
    });

    it("returns grouped results when groupBy=task", async () => {
      const groupedDocs = [
        { key: "tp-1", label: "Build a calculator", aggregates: { count: 3, turns: { min: 1, max: 3, mean: 2, stdDev: 0.8 }, duration: null, promptTokens: null, completionTokens: null }, uniform: { workerType: "coder-acp-copilot" } },
      ];
      // aggregate is called multiple times: key pipeline, phase2, hasMoreAfter, hasMoreBefore
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ _id: "tp-1" }]) }) // keys
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue(groupedDocs) }) // phase2
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }) // hasMoreAfter
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // hasMoreBefore

      const res = await request(app).get("/api/v1/requests?groupBy=task");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toHaveProperty("key", "tp-1");
      expect(res.body.data[0]).toHaveProperty("aggregates");
      expect(res.body.data[0].aggregates).toHaveProperty("count", 3);
      expect(res.body.data[0]).toHaveProperty("uniform");
    });

    it("returns grouped results when groupBy=submissionId", async () => {
      const groupedDocs = [
        { key: "sub-1", label: "sub-1", aggregates: { count: 2, turns: null, duration: null, promptTokens: null, completionTokens: null }, uniform: {} },
      ];
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ _id: "sub-1" }]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue(groupedDocs) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) });

      const res = await request(app).get("/api/v1/requests?groupBy=submissionId");
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toHaveProperty("key", "sub-1");
    });

    it("calls aggregate pipeline when groupBy is provided", async () => {
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // keys (empty)

      await request(app).get("/api/v1/requests?groupBy=task");
      expect(mocks.collection.aggregate).toHaveBeenCalled();
      // Phase 1 key pipeline: $match, $group, $sort, $limit
      const pipeline = (mocks.collection.aggregate as any).mock.calls[0][0];
      expect(pipeline[0]).toHaveProperty("$match");
      expect(pipeline[1]).toHaveProperty("$group");
    });

    it("does not call aggregate when groupBy is absent", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(app).get("/api/v1/requests");
      expect(mocks.collection.aggregate).not.toHaveBeenCalled();
    });

    it("passes status filter to find query", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(app).get("/api/v1/requests?status=done");
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.status": "done" }),
      );
    });

    it("passes outcome filter to find query", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(app).get("/api/v1/requests?outcome=succeeded");
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.outcome": "succeeded" }),
      );
    });

    it("passes status and outcome filters to aggregate pipeline $match", async () => {
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ count: 0 }]) });

      await request(app).get("/api/v1/requests?groupBy=task&status=done&outcome=failed");
      const pipeline = (mocks.collection.aggregate as any).mock.calls[0][0];
      expect(pipeline[0]).toEqual(
        expect.objectContaining({
          $match: expect.objectContaining({ "run.status": "done", "run.outcome": "failed" }),
        }),
      );
    });

    it("combines status, outcome, and worker filters", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(app).get("/api/v1/requests?status=processing&outcome=succeeded&worker=coder-acp-copilot");
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({
          "run.status": "processing",
          "run.outcome": "succeeded",
          workerType: "coder-acp-copilot",
        }),
      );
    });
  });

  describe("GET /api/v1/requests/:id", () => {
    it("returns 200 when request exists", async () => {
      const doc = { _id: "r1", scenario: { task: "t", criteria: [] }, workerType: "coder-acp-copilot", status: "completed" };
      (mocks.collection.findOne as any).mockResolvedValue(doc);

      const res = await request(app).get("/api/v1/requests/r1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "r1");
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/requests/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/requests/:id", () => {
    it("returns 200 when request is soft-deleted", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(app).delete("/api/v1/requests/r1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("deleted", true);
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(app).delete("/api/v1/requests/missing");
      expect(res.status).toBe(404);
    });

    it("returns 410 when request already deleted", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue({ _id: "r1", deletedAt: new Date() });

      const res = await request(app).delete("/api/v1/requests/r1");
      expect(res.status).toBe(410);
    });
  });

  // ===================================================================
  // Reports endpoints
  // ===================================================================

  describe("GET /api/v1/reports", () => {
    it("returns 200 with array of reports", async () => {
      const reports = [{ _id: "rp1", requestId: "r1", status: "completed", createdAt: new Date() }];
      (mocks.reportCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(reports),
        }),
      });
      // For run task enrichment
      (mocks.collection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const res = await request(app).get("/api/v1/reports");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/reports", () => {
    it("returns 201 when creating a report", async () => {
      // Run exists
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "r1",
        status: "completed",
      });

      const res = await request(app)
        .post("/api/v1/reports")
        .send({ requestId: "r1" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("requestId", "r1");
      expect(res.body).toHaveProperty("status", "pending");
    });

    it("returns 400 when requestId missing", async () => {
      const res = await request(app)
        .post("/api/v1/reports")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 when referenced run not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/reports")
        .send({ requestId: "no-such-run" });

      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Report Templates endpoints
  // ===================================================================

  describe("GET /api/v1/report-templates", () => {
    it("returns 200 with array of report templates", async () => {
      const templates = [{ id: "rt1", name: "Default", userPrompt: "Analyze", createdAt: new Date() }];
      (mocks.reportTemplateCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(templates),
      });

      const res = await request(app).get("/api/v1/report-templates");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===================================================================
  // Feature Flags endpoints
  // ===================================================================

  describe("GET /api/v1/feature-flags", () => {
    it("returns 200 with array of feature flags", async () => {
      const flags = [{ key: "mcp", label: "MCP", enabled: true }];
      (mocks.featureFlagCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(flags),
      });

      const res = await request(app).get("/api/v1/feature-flags");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===================================================================
  // Skills endpoints
  // ===================================================================

  describe("GET /api/v1/skills", () => {
    it("returns 200 with array of skills", async () => {
      const skills = [{ _id: "org/repo/skill", name: "My Skill", source: "org/repo", skillName: "skill", createdAt: new Date() }];
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(skills),
      });

      const res = await request(app).get("/api/v1/skills");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "org/repo/skill");
    });
  });

  // ===================================================================
  // Prompt Features endpoints
  // ===================================================================

  describe("GET /api/v1/prompt-features", () => {
    it("returns 200 with array of prompt features", async () => {
      const features = [{ id: "pf1", prompt: "Does X?", createdAt: new Date() }];
      (mocks.promptFeatureCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(features),
      });

      const res = await request(app).get("/api/v1/prompt-features");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/prompt-features", () => {
    it("returns 201 when creating a prompt feature", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/prompt-features")
        .send({ id: "new_feature", prompt: "Does it have X?" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new_feature");
    });

    it("returns 400 when id has invalid format", async () => {
      const res = await request(app)
        .post("/api/v1/prompt-features")
        .send({ id: "Invalid-ID", prompt: "Bad id" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/prompt-features/:id", () => {
    it("returns 200 when prompt feature exists", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue({
        id: "pf1",
        prompt: "Check X",
        createdAt: new Date(),
      });

      const res = await request(app).get("/api/v1/prompt-features/pf1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "pf1");
    });

    it("returns 404 when prompt feature not found", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app).get("/api/v1/prompt-features/missing");
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Task Prompts endpoints
  // ===================================================================

  describe("GET /api/v1/task-prompts", () => {
    it("returns 200 with paginated task prompts", async () => {
      (mocks.taskPromptStore as any).getAll.mockResolvedValue({
        items: [{ _id: "tp1", text: "Build a form", createdAt: new Date() }],
        total: 1,
      });

      const res = await request(app).get("/api/v1/task-prompts");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(res.body).toHaveProperty("total", 1);
    });
  });

  describe("GET /api/v1/task-prompts/:id", () => {
    it("returns 200 when task prompt exists", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue({
        _id: "tp1",
        text: "Build a form",
        createdAt: new Date(),
      });

      const res = await request(app).get("/api/v1/task-prompts/tp1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("_id", "tp1");
    });

    it("returns 404 when task prompt not found", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue(null);

      const res = await request(app).get("/api/v1/task-prompts/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/task-prompts", () => {
    it("returns 201 when creating a task prompt", async () => {
      (mocks.taskPromptStore as any).findOrCreate.mockResolvedValue({
        _id: "tp-new",
        text: "New task",
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/api/v1/task-prompts")
        .send({ text: "New task" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("text", "New task");
    });

    it("returns 400 when text is missing", async () => {
      const res = await request(app)
        .post("/api/v1/task-prompts")
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ===================================================================
  // Submit with profile — server-side field resolution
  // ===================================================================

  describe("POST /api/v1/requests?worker=... (profile)", () => {
    it("applies profile fields server-side, ignoring client-omitted fields", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: ["ms-learn"],
        skillRevisions: ["github/awesome-copilot/cosmosdb@abc123"],
        extensions: [],
      });
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        versions: [{ agentVersion: "v1", status: "active", createdAt: new Date() }],
        supportedModels: ["claude-sonnet-4"],
      });
      // resolveSkillSpecs will validate the skill slug exists
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "github/awesome-copilot/cosmosdb" }]),
      });
      // Mock the skill revision store getByRef
      (mocks.skillRevisionStore.getByRef as any).mockResolvedValue({
        _id: "rev-1",
        ref: "github/awesome-copilot/cosmosdb@abc123",
      });
      // Mock MCP server validation (ms-learn exists)
      (mocks.mcpServerCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "ms-learn" }]),
      });

      const res = await request(app)
        .post("/api/v1/requests?worker=coder-acp-copilot")
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          // Client omits model, mcpServers, skills, extensions — profile provides them
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
      expect(doc).toHaveProperty("mcpServers", ["ms-learn"]);
      expect(doc).toHaveProperty("skillRevisions", ["github/awesome-copilot/cosmosdb@abc123"]);
      expect(doc).toHaveProperty("profileId", "profile-1");
      expect(doc).toHaveProperty("profileVersionId", "pv-1");
    });

    it("returns 400 when client sends fields conflicting with profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: [],
        skillRevisions: [],
        extensions: [],
      });

      const res = await request(app)
        .post("/api/v1/requests?worker=coder-acp-copilot")
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          model: "gpt-4o", // conflicts with profile's claude-sonnet-4
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("controls these fields");
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("model")])
      );
    });
  });

  // ===================================================================
  // Bulk resubmit
  // ===================================================================

  describe("POST /api/v1/requests/bulk-resubmit", () => {
    it("preserves agentVersion and taskPromptId from original run", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        agentVersion: "copilot-0.0.415",
        taskPromptId: "tp-123",
        personaInstructions: "Be helpful",
        createdAt: new Date(),
        maxIterations: 5,
      };

      // Mock collection.find to return the original run
      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      // Mock agentCollection.findOne to return an agent with an active version
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o"],
      });

      const res = await request(app)
        .post("/api/v1/requests/bulk-resubmit")
        .send({ ids: ["run-original"], count: 1 });

      expect(res.status).toBe(201);

      // Verify the inserted document includes agentVersion and taskPromptId
      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall).toHaveLength(1);
      expect(insertCall[0]).toHaveProperty("agentVersion", "copilot-0.0.420");
      expect(insertCall[0]).toHaveProperty("taskPromptId", "tp-123");
      expect(insertCall[0]).toHaveProperty("model", "gpt-4o");
      expect(insertCall[0]).toHaveProperty("maxIterations", 5);
    });

    it("applies profile override: uses profile fields for worker, model, mcpServers, skillRevisions, extensions", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      // Profile + version mocks
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 2,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-2",
        profileId: "profile-1",
        version: 2,
        workerType: "coder-vscode-insiders",
        model: "claude-sonnet-4",
        mcpServers: ["mcp-a"],
        skillRevisions: ["skill-a@v1"],
        extensions: ["ext-a"],
      });

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-vscode-insiders",
        versions: [
          { agentVersion: "insiders-0.1.0", queueName: "queue-vscode-insiders", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["claude-sonnet-4"],
      });

      // Skill resolution mocks (resolveSkillSpecs validates slug + pinned ref)
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "skill-a" }]),
      });
      (mocks.skillRevisionStore.getByRef as any).mockResolvedValue({
        _id: "rev-skill-a",
        ref: "skill-a@v1",
      });

      const res = await request(app)
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-original"],
          count: 1,
          overrides: {
            profileId: "profile-1",
            maxIterations: 10, // not controlled by profile — allowed
          },
        });

      expect(res.status).toBe(201);

      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall).toHaveLength(1);
      const doc = insertCall[0];
      // Profile-controlled fields come from profile version
      expect(doc).toHaveProperty("workerType", "coder-vscode-insiders");
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
      expect(doc).toHaveProperty("mcpServers", ["mcp-a"]);
      expect(doc).toHaveProperty("skillRevisions", ["skill-a@v1"]);
      expect(doc).toHaveProperty("extensions", ["ext-a"]);
      expect(doc).toHaveProperty("profileId", "profile-1");
      expect(doc).toHaveProperty("profileVersionId", "pv-2");
      // maxIterations is not profile-controlled
      expect(doc).toHaveProperty("maxIterations", 10);
    });

    it("detaches profile when profileId override is null", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        profileId: "old-profile",
        profileVersionId: "old-pv",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o"],
      });

      const res = await request(app)
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-original"],
          count: 1,
          overrides: { profileId: null, model: "claude-sonnet-4" },
        });

      expect(res.status).toBe(201);

      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      const doc = insertCall[0];
      // Profile detached — no profile fields
      expect(doc.profileId).toBeUndefined();
      expect(doc.profileVersionId).toBeUndefined();
      // Individual overrides respected since no profile active
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
    });

    it("returns 404 when profile override references non-existent profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-1"],
          count: 1,
          overrides: { profileId: "nonexistent" },
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Profile not found");
    });

    it("returns 400 when individual overrides conflict with profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: [],
        skillRevisions: [],
        extensions: [],
      });

      const res = await request(app)
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-1"],
          count: 1,
          overrides: {
            profileId: "profile-1",
            model: "gpt-4o", // conflicts with profile
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("controls these fields");
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("model")])
      );
    });
  });

  // ===================================================================
  // Run-retry-attempts (issue #658)
  // ===================================================================

  describe("GET /api/v1/requests/:id/runs", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await request(app).get("/api/v1/requests/missing/runs");
      expect(res.status).toBe(404);
    });

    it("returns current run + history newest first", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed", requestId: "req-1" },
          ]),
        }),
      });
      const res = await request(app).get("/api/v1/requests/req-1/runs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]._id).toBe("run-2");
      expect(res.body[1]._id).toBe("run-1");
    });
  });

  describe("GET /api/v1/requests/:id/runs/:runId", () => {
    it("returns the inline current run when runId matches", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      const res = await request(app).get("/api/v1/requests/req-1/runs/run-2");
      expect(res.status).toBe(200);
      expect(res.body._id).toBe("run-2");
    });

    it("falls back to history collection for older attempts", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.findOne as any).mockResolvedValue({
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        outcome: "failed",
        requestId: "req-1",
      });
      const res = await request(app).get("/api/v1/requests/req-1/runs/run-1");
      expect(res.status).toBe(200);
      expect(res.body._id).toBe("run-1");
    });

    it("returns 404 when run id doesn't belong to the request", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.findOne as any).mockResolvedValue({
        _id: "run-x",
        requestId: "other-req",
        attemptNumber: 1,
        status: "done",
      });
      const res = await request(app).get("/api/v1/requests/req-1/runs/run-x");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/requests/:id/retry", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await request(app).post("/api/v1/requests/missing/retry");
      expect(res.status).toBe(404);
    });

    it("returns 422 when current run is not yet terminal", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "processing" },
      });
      const res = await request(app).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("expected 'done'");
    });

    it("demotes current run to history, swaps in a new attempt, queues message", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      const queueClient = mocks.queueClients.get("coder-acp-copilot")!;

      const res = await request(app).post("/api/v1/requests/req-1/retry");

      expect(res.status).toBe(201);
      expect(res.body.attemptNumber).toBe(2);
      expect(res.body.requestId).toBe("req-1");
      expect(typeof res.body.runId).toBe("string");
      expect(mocks.runsCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "run-1", requestId: "req-1" }),
      );
      expect(mocks.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1", "run._id": "run-1" },
        expect.objectContaining({
          $set: expect.objectContaining({
            run: expect.objectContaining({ attemptNumber: 2, status: "pending" }),
          }),
        }),
      );
      expect((queueClient.sendMessage as any)).toHaveBeenCalled();
    });

    it("returns 409 when concurrent retry wins the race", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

      const res = await request(app).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(409);
    });

    it("returns 409 when request is soft-deleted", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        deletedAt: new Date(),
        run: { _id: "run-1", attemptNumber: 1, status: "done" },
      });
      const res = await request(app).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(409);
    });

    it("ignores duplicate-key error on history insertion", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      const dupErr: any = new Error("E11000 duplicate key");
      dupErr.code = 11000;
      (mocks.runsCollection.insertOne as any).mockRejectedValue(dupErr);
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(app).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/v1/requests/bulk-retry", () => {
    it("retries eligible requests and skips non-terminal ones", async () => {
      const doc1 = {
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      };
      const doc2 = {
        _id: "req-2",
        workerType: "coder-acp-copilot",
        run: { _id: "run-2", attemptNumber: 1, status: "processing" },
      };
      // find().toArray() is used by bulk-retry to fetch all docs at once
      const mockCursor = { toArray: vi.fn().mockResolvedValue([doc1, doc2]), sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), filter: vi.fn().mockReturnThis(), project: vi.fn().mockReturnThis() };
      (mocks.collection.find as any).mockReturnValue(mockCursor);
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(app)
        .post("/api/v1/requests/bulk-retry")
        .send({ ids: ["req-1", "req-2"] });

      expect(res.status).toBe(200);
      expect(res.body.retried).toBe(1);
      expect(res.body.skipped).toBe(1);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results.find((r: any) => r.requestId === "req-1").attemptNumber).toBe(2);
      expect(res.body.results.find((r: any) => r.requestId === "req-2").error).toContain("processing");
    });

    it("returns 400 when ids array is empty", async () => {
      const res = await request(app)
        .post("/api/v1/requests/bulk-retry")
        .send({ ids: [] });
      expect(res.status).toBe(400);
    });
  });
});
