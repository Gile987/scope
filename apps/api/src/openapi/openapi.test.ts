// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import express from "express";
import { z } from "zod";
import { generateOpenAPIDocument, registry } from "./index.js";
import { apiRoute } from "./api-route.js";
import {
  CreateCriteriaInputSchema,
  UpdateCriteriaInputSchema,
  CriteriaResponseSchema,
  CriteriaGraphSchema,
  ModelResponseSchema,
  ListModelsQuerySchema,
  McpServerResponseSchema,
  UpdateMcpServerInputSchema,
  McpTransportTypeSchema,
  McpServerHeaderSchema,
  FeatureFlagResponseSchema,
  UpdateFeatureFlagInputSchema,
  AgentResponseSchema,
  AgentVersionSchema,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
  RegisterAgentVersionInputSchema,
  PatchAgentVersionInputSchema,
  CreateReportTemplateInputSchema,
  UpdateReportTemplateInputSchema,
  ReportTemplateResponseSchema,
} from "shared";

// Register apiRoute()-based routes so they appear in the OpenAPI doc.
// These need an Express app + the registry; we use a throwaway app since
// we only care about the registry side-effect here, not the Express handlers.
const testApp = express();
const noop = () => {};

// Health / System
apiRoute(testApp, registry, {
  method: "get", path: "/health", tags: ["Health"],
  summary: "Liveness probe", response: z.object({ status: z.string(), version: z.string() }), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/ready", tags: ["Health"],
  summary: "Readiness probe", response: z.object({ status: z.string(), migrations: z.any() }),
  errorResponses: { 503: { description: "Service is not ready" } }, handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/about", tags: ["System"],
  summary: "API metadata", response: z.object({ name: z.string(), version: z.string(), buildTime: z.string(), environment: z.string(), description: z.string(), workers: z.array(z.string()) }), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/version", tags: ["System"],
  summary: "Version info", response: z.object({ commit: z.string(), buildTime: z.string(), environment: z.string() }), handler: noop,
});

// Feature flags
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/feature-flags", tags: ["Feature Flags"],
  summary: "List feature flags", response: z.array(FeatureFlagResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "put", path: "/api/v1/feature-flags/:key", tags: ["Feature Flags"],
  summary: "Update feature flag", params: z.object({ key: z.string() }),
  body: UpdateFeatureFlagInputSchema, response: FeatureFlagResponseSchema, handler: noop,
});

// Models
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/models", tags: ["Models"],
  summary: "List models", query: ListModelsQuerySchema,
  response: z.array(ModelResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/models/:id", tags: ["Models"],
  summary: "Get model", params: z.object({ id: z.string() }),
  response: ModelResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/models/sync", tags: ["Models"],
  summary: "Sync models from provider",
  body: z.object({ agentId: z.string(), provider: z.string(), models: z.array(z.object({ id: z.string() })), scannedAt: z.string() }),
  response: z.object({ added: z.array(z.string()), removed: z.array(z.string()), unchanged: z.array(z.string()) }),
  handler: noop,
});

// MCP Servers
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/mcp/servers", tags: ["MCP Servers"],
  summary: "List MCP servers", response: z.array(McpServerResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/mcp/servers/:id", tags: ["MCP Servers"],
  summary: "Get MCP server", params: z.object({ id: z.string() }),
  response: McpServerResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/mcp/servers", tags: ["MCP Servers"],
  summary: "Create MCP server",
  body: z.object({ _id: z.string(), name: z.string(), type: McpTransportTypeSchema, url: z.string(), headers: z.array(McpServerHeaderSchema).optional(), description: z.string().optional() }),
  response: McpServerResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "put", path: "/api/v1/mcp/servers/:id", tags: ["MCP Servers"],
  summary: "Update MCP server", params: z.object({ id: z.string() }),
  body: UpdateMcpServerInputSchema, response: McpServerResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "delete", path: "/api/v1/mcp/servers/:id", tags: ["MCP Servers"],
  summary: "Delete MCP server", params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }), successStatus: 204, handler: noop,
});

// Criteria
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/criteria/generate-prompt", tags: ["Criteria"],
  summary: "Generate criterion prompt from behavior",
  body: z.object({ behavior: z.string(), currentId: z.string().optional() }),
  response: z.object({ prompt: z.string() }), handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/criteria/seed", tags: ["Criteria"],
  summary: "Seed criteria in bulk",
  body: z.object({ criteria: z.array(CreateCriteriaInputSchema) }),
  response: z.object({ seeded: z.number(), errors: z.array(z.string()) }), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/criteria", tags: ["Criteria"],
  summary: "List criteria", query: z.object({ q: z.string().optional() }),
  response: z.array(CriteriaResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/criteria/mdp", tags: ["Criteria"],
  summary: "Compute MDP transitions",
  query: z.object({ criteria: z.string().optional(), features: z.string().optional(), since: z.string().optional(), worker: z.string().optional(), taskPromptId: z.string().optional() }),
  response: z.object({}).passthrough(), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/criteria/graph", tags: ["Criteria"],
  summary: "Get criteria DAG", response: CriteriaGraphSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/criteria/:id", tags: ["Criteria"],
  summary: "Get criterion", params: z.object({ id: z.string() }),
  response: CriteriaResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/criteria", tags: ["Criteria"],
  summary: "Create criterion", body: CreateCriteriaInputSchema,
  response: CriteriaResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "put", path: "/api/v1/criteria/:id", tags: ["Criteria"],
  summary: "Update criterion", params: z.object({ id: z.string() }),
  body: UpdateCriteriaInputSchema, response: CriteriaResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "delete", path: "/api/v1/criteria/:id", tags: ["Criteria"],
  summary: "Soft-delete criterion", params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), deleted: z.boolean() }), handler: noop,
});

// Agents
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/agents", tags: ["Agents"],
  summary: "List agents", response: z.array(AgentResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/agents/:id", tags: ["Agents"],
  summary: "Get agent", params: z.object({ id: z.string() }),
  response: AgentResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/agents", tags: ["Agents"],
  summary: "Create or update agent (upsert)", body: CreateAgentInputSchema,
  response: AgentResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "put", path: "/api/v1/agents/:id", tags: ["Agents"],
  summary: "Update agent", params: z.object({ id: z.string() }),
  body: UpdateAgentInputSchema, response: AgentResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "delete", path: "/api/v1/agents/:id", tags: ["Agents"],
  summary: "Delete agent", params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }), successStatus: 204, handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/agents/:id/versions", tags: ["Agents"],
  summary: "List agent versions", params: z.object({ id: z.string() }),
  query: z.object({ status: z.string().optional() }),
  response: z.array(AgentVersionSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/agents/:id/versions", tags: ["Agents"],
  summary: "Register agent version (upsert)", params: z.object({ id: z.string() }),
  body: RegisterAgentVersionInputSchema, response: AgentVersionSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "patch", path: "/api/v1/agents/:id/versions/:agentVersion", tags: ["Agents"],
  summary: "Patch agent version", params: z.object({ id: z.string(), agentVersion: z.string() }),
  body: PatchAgentVersionInputSchema, response: AgentVersionSchema, handler: noop,
});

// Report Templates
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/report-templates/default-system-prompt", tags: ["Report Templates"],
  summary: "Get default system prompt", response: z.object({ content: z.string() }), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/report-templates", tags: ["Report Templates"],
  summary: "List report templates", query: z.object({ q: z.string().optional() }),
  response: z.array(ReportTemplateResponseSchema), handler: noop,
});
apiRoute(testApp, registry, {
  method: "get", path: "/api/v1/report-templates/:id", tags: ["Report Templates"],
  summary: "Get report template", params: z.object({ id: z.string() }),
  response: ReportTemplateResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "post", path: "/api/v1/report-templates", tags: ["Report Templates"],
  summary: "Create report template", body: CreateReportTemplateInputSchema,
  response: ReportTemplateResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "put", path: "/api/v1/report-templates/:id", tags: ["Report Templates"],
  summary: "Update report template", params: z.object({ id: z.string() }),
  body: UpdateReportTemplateInputSchema, response: ReportTemplateResponseSchema, handler: noop,
});
apiRoute(testApp, registry, {
  method: "delete", path: "/api/v1/report-templates/:id", tags: ["Report Templates"],
  summary: "Delete report template", params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }), successStatus: 204, handler: noop,
});

describe("OpenAPI document generation", () => {
  const doc = generateOpenAPIDocument();

  it("generates without error and returns an object", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });

  // -------------------------------------------------------------------------
  // Required OpenAPI fields
  // -------------------------------------------------------------------------
  describe("required OpenAPI fields", () => {
    it("has openapi version 3.1.0", () => {
      expect(doc.openapi).toBe("3.1.0");
    });

    it("has info.title", () => {
      expect(doc.info.title).toBeDefined();
      expect(typeof doc.info.title).toBe("string");
      expect(doc.info.title.length).toBeGreaterThan(0);
    });

    it("has info.version", () => {
      expect(doc.info.version).toBeDefined();
    });

    it("has paths as an object with keys", () => {
      expect(doc.paths).toBeDefined();
      expect(typeof doc.paths).toBe("object");
      expect(Object.keys(doc.paths!).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Expected paths
  // -------------------------------------------------------------------------
  describe("expected paths", () => {
    const expectedPaths = [
      "/health",
      "/api/v1/requests",
      "/api/v1/criteria",
      "/api/v1/agents",
      "/api/v1/reports",
      "/api/v1/insights",
      "/api/v1/models",
      "/api/v1/mcp/servers",
      "/api/v1/skills",
      "/api/v1/feature-flags",
    ];

    it.each(expectedPaths)("has path %s", (path) => {
      expect(doc.paths![path]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Paths have correct methods
  // -------------------------------------------------------------------------
  describe("paths have expected HTTP methods", () => {
    it("/api/v1/requests has GET and POST", () => {
      const pathItem = doc.paths!["/api/v1/requests"];
      expect(pathItem).toBeDefined();
      expect(pathItem!.get).toBeDefined();
      expect(pathItem!.post).toBeDefined();
    });

    it("/api/v1/criteria has GET and POST", () => {
      const pathItem = doc.paths!["/api/v1/criteria"];
      expect(pathItem).toBeDefined();
      expect(pathItem!.get).toBeDefined();
      expect(pathItem!.post).toBeDefined();
    });

    it("/health has GET", () => {
      const pathItem = doc.paths!["/health"];
      expect(pathItem).toBeDefined();
      expect(pathItem!.get).toBeDefined();
    });

    it("/api/v1/agents has GET and POST", () => {
      const pathItem = doc.paths!["/api/v1/agents"];
      expect(pathItem).toBeDefined();
      expect(pathItem!.get).toBeDefined();
      expect(pathItem!.post).toBeDefined();
    });

    it("/api/v1/insights has GET and POST", () => {
      const pathItem = doc.paths!["/api/v1/insights"];
      expect(pathItem).toBeDefined();
      expect(pathItem!.get).toBeDefined();
      expect(pathItem!.post).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Components / schemas
  // -------------------------------------------------------------------------
  describe("components.schemas", () => {
    it("has components.schemas defined", () => {
      expect(doc.components).toBeDefined();
      expect(doc.components!.schemas).toBeDefined();
      expect(typeof doc.components!.schemas).toBe("object");
    });

    const expectedSchemas = [
      "RequestResponse",
      "CriteriaResponse",
      "ReportResponse",
      "CreateRequestInput",
      "CreateCriteriaInput",
      "Scenario",
      "Persona",
      "AgentResponse",
      "InsightResponse",
      "ModelResponse",
      "McpServerResponse",
      "SkillResponse",
      "FeatureFlagResponse",
      "ReportTemplateResponse",
      "LogEvent",
    ];

    it.each(expectedSchemas)("contains schema '%s'", (schemaName) => {
      expect(doc.components!.schemas![schemaName]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // $ref resolution
  // -------------------------------------------------------------------------
  describe("$ref resolution", () => {
    it("all $ref values point to existing component schemas", () => {
      const schemas = doc.components?.schemas ?? {};
      const refs: string[] = [];

      // Recursively collect all $ref values from the document
      function collectRefs(obj: unknown): void {
        if (obj === null || obj === undefined) return;
        if (typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          obj.forEach(collectRefs);
          return;
        }
        const record = obj as Record<string, unknown>;
        if (typeof record["$ref"] === "string") {
          refs.push(record["$ref"]);
        }
        for (const val of Object.values(record)) {
          collectRefs(val);
        }
      }

      collectRefs(doc.paths);

      // Filter to only component schema refs
      const schemaRefs = refs.filter((r) =>
        r.startsWith("#/components/schemas/"),
      );

      expect(schemaRefs.length).toBeGreaterThan(0);

      for (const ref of schemaRefs) {
        const schemaName = ref.replace("#/components/schemas/", "");
        expect(
          schemas[schemaName],
          `$ref "${ref}" should resolve to an existing schema`,
        ).toBeDefined();
      }
    });
  });
});
