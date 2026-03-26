// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import express from "express";
import { generateOpenAPIDocument, registry } from "./index.js";
import { registerFeatureFlagRoutes } from "../routes/feature-flags.js";
import { registerModelRoutes } from "../routes/models.js";
import { registerMcpServerRoutes } from "../routes/mcp-servers.js";
import { registerCriteriaRoutes } from "../routes/criteria.js";

// Register apiRoute()-based routes so they appear in the OpenAPI doc.
// These need an Express app + the registry; we use a throwaway app since
// we only care about the registry side-effect here, not the Express handlers.
const testApp = express();
const testCtx = { app: testApp, registry } as any;
registerFeatureFlagRoutes(testCtx);
registerModelRoutes(testCtx);
registerMcpServerRoutes(testCtx);
registerCriteriaRoutes(testCtx);

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
