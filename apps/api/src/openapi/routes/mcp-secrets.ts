// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";

extendZodWithOpenApi(z);

const McpSecretInputSchema = z.object({
  name: z.string().describe("Secret name (e.g. AZURE_CLIENT_SECRET or Authorization)"),
  value: z.string().describe("Secret plaintext value"),
});

const McpSecretResponseSchema = z.object({
  id: z.string(),
  mcpId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const IdParam = z.object({ id: z.string().describe("MCP server slug") });
const IdNameParams = z.object({
  id: z.string().describe("MCP server slug"),
  name: z.string().describe("Secret name"),
});

// POST /api/v1/mcp/servers/:id/secrets
registry.registerPath({
  method: "post",
  path: "/api/v1/mcp/servers/{id}/secrets",
  tags: ["MCP Secrets"],
  summary: "Store or update a secret for an MCP server",
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": { schema: McpSecretInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Secret stored",
      content: {
        "application/json": { schema: McpSecretResponseSchema },
      },
    },
  },
});

// GET /api/v1/mcp/servers/:id/secrets
registry.registerPath({
  method: "get",
  path: "/api/v1/mcp/servers/{id}/secrets",
  tags: ["MCP Secrets"],
  summary: "List secret metadata for an MCP server (no values)",
  request: {
    params: IdParam,
  },
  responses: {
    200: {
      description: "Secret metadata list",
      content: {
        "application/json": { schema: z.array(McpSecretResponseSchema) },
      },
    },
  },
});

// DELETE /api/v1/mcp/servers/:id/secrets/:name
registry.registerPath({
  method: "delete",
  path: "/api/v1/mcp/servers/{id}/secrets/{name}",
  tags: ["MCP Secrets"],
  summary: "Delete a secret by name",
  request: {
    params: IdNameParams,
  },
  responses: {
    200: {
      description: "Secret deleted",
    },
    404: {
      description: "Secret not found",
    },
  },
});
