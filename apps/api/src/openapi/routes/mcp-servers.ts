// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateMcpServerInputSchema,
  UpdateMcpServerInputSchema,
  McpServerResponseSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/mcp/servers
registry.registerPath({
  method: "get",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "List MCP servers",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(McpServerResponseSchema) },
      },
    },
  },
});

// GET /api/v1/mcp/servers/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/mcp/servers/{id}",
  tags: ["MCP Servers"],
  summary: "Get MCP server",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: McpServerResponseSchema },
      },
    },
  },
});

// POST /api/v1/mcp/servers
registry.registerPath({
  method: "post",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "Create MCP server",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateMcpServerInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "MCP server created",
      content: {
        "application/json": { schema: McpServerResponseSchema },
      },
    },
  },
});

// PUT /api/v1/mcp/servers/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/mcp/servers/{id}",
  tags: ["MCP Servers"],
  summary: "Update MCP server",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateMcpServerInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "MCP server updated",
      content: {
        "application/json": { schema: McpServerResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/mcp/servers/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/mcp/servers/{id}",
  tags: ["MCP Servers"],
  summary: "Delete MCP server",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "MCP server deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});
