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
    it("returns 200 with array of requests", async () => {
      const docs = [{ _id: "r1", scenario: { task: "t", criteria: [] }, workerType: "coder-acp-copilot", status: "completed", createdAt: new Date() }];
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(docs),
        }),
      });

      const res = await request(app).get("/api/v1/requests");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "r1");
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
});
