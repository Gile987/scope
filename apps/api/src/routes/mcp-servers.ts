// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  McpServerResponseSchema,
  UpdateMcpServerInputSchema,
  McpTransportTypeSchema,
  McpServerHeaderSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext, McpServerDocument } from "../route-context.js";

// Create schema includes _id (slug) which the shared schema omits
const CreateMcpServerBodySchema = z.object({
  _id: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  name: z.string(),
  type: McpTransportTypeSchema,
  url: z.string(),
  headers: z.array(McpServerHeaderSchema).optional(),
  description: z.string().optional(),
});

export function registerMcpServerRoutes(ctx: RouteContext): void {
  const { app, registry, mcpServerCollection } = ctx;

  // GET /api/v1/mcp/servers — list MCP servers
  apiRoute(app, registry, {
    method: "get",
    path: "/api/v1/mcp/servers",
    tags: ["MCP Servers"],
    summary: "List MCP servers",
    response: z.array(McpServerResponseSchema),
    handler: async (_req, res) => {
      const servers = await mcpServerCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();
      servers.sort((a, b) => a._id.localeCompare(b._id));
      res.json(servers.map((s) => ({ ...s, id: s._id })));
    },
  });

  // GET /api/v1/mcp/servers/:id — get MCP server by slug
  apiRoute(app, registry, {
    method: "get",
    path: "/api/v1/mcp/servers/:id",
    tags: ["MCP Servers"],
    summary: "Get MCP server",
    params: z.object({ id: z.string() }),
    response: McpServerResponseSchema,
    handler: async (req, res) => {
      const server = await mcpServerCollection.findOne({
        _id: req.params.id,
        deletedAt: { $exists: false },
      });
      if (!server) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }
      res.json({ ...server, id: server._id });
    },
  });

  // POST /api/v1/mcp/servers — create MCP server (upserts if soft-deleted)
  apiRoute(app, registry, {
    method: "post",
    path: "/api/v1/mcp/servers",
    tags: ["MCP Servers"],
    summary: "Create MCP server",
    body: CreateMcpServerBodySchema,
    response: McpServerResponseSchema,
    handler: async (req, res) => {
      const { _id, name, type, url, headers, description } = req.body;
      const now = new Date();
      const existing = await mcpServerCollection.findOne({ _id });

      if (existing) {
        // Upsert: un-delete if soft-deleted, update fields
        await mcpServerCollection.updateOne(
          { _id },
          {
            $set: {
              name,
              type,
              url,
              ...(headers !== undefined ? { headers } : {}),
              ...(description !== undefined ? { description } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          },
        );
        const updated = await mcpServerCollection.findOne({ _id });
        res.json({ ...updated, id: updated!._id });
      } else {
        const serverDoc: McpServerDocument = {
          _id,
          name,
          type,
          url,
          ...(headers ? { headers } : {}),
          ...(description ? { description } : {}),
          createdAt: now,
        };
        await mcpServerCollection.insertOne(serverDoc);
        res.status(201).json({ ...serverDoc, id: serverDoc._id });
      }
    },
  });

  // PUT /api/v1/mcp/servers/:id — update MCP server
  apiRoute(app, registry, {
    method: "put",
    path: "/api/v1/mcp/servers/:id",
    tags: ["MCP Servers"],
    summary: "Update MCP server",
    params: z.object({ id: z.string() }),
    body: UpdateMcpServerInputSchema,
    response: McpServerResponseSchema,
    handler: async (req, res) => {
      const { id } = req.params;
      const { name, type, url, headers, description } = req.body;

      const existing = await mcpServerCollection.findOne({
        _id: id,
        deletedAt: { $exists: false },
      });
      if (!existing) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updateFields.name = name;
      if (type !== undefined) updateFields.type = type;
      if (url !== undefined) updateFields.url = url;
      if (headers !== undefined) updateFields.headers = headers;
      if (description !== undefined) updateFields.description = description;

      await mcpServerCollection.updateOne({ _id: id }, { $set: updateFields });
      const updated = await mcpServerCollection.findOne({ _id: id });
      res.json({ ...updated, id: updated!._id });
    },
  });

  // DELETE /api/v1/mcp/servers/:id — soft-delete MCP server
  apiRoute(app, registry, {
    method: "delete",
    path: "/api/v1/mcp/servers/:id",
    tags: ["MCP Servers"],
    summary: "Delete MCP server",
    params: z.object({ id: z.string() }),
    response: z.object({ message: z.string() }),
    successStatus: 204,
    handler: async (req, res) => {
      const { id } = req.params;

      const existing = await mcpServerCollection.findOne({
        _id: id,
        deletedAt: { $exists: false },
      });
      if (!existing) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }

      await mcpServerCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
      );

      res.status(204).send();
    },
  });
}
