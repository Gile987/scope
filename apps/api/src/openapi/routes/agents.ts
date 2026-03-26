// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
  AgentResponseSchema,
  AgentVersionSchema,
  RegisterAgentVersionInputSchema,
  PatchAgentVersionInputSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/agents
registry.registerPath({
  method: "get",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "List agents",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(AgentResponseSchema) },
      },
    },
  },
});

// GET /api/v1/agents/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Get agent",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: AgentResponseSchema },
      },
    },
  },
});

// POST /api/v1/agents
registry.registerPath({
  method: "post",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "Create or update agent (upsert)",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateAgentInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Agent updated",
      content: {
        "application/json": { schema: AgentResponseSchema },
      },
    },
    201: {
      description: "Agent created",
      content: {
        "application/json": { schema: AgentResponseSchema },
      },
    },
  },
});

// PUT /api/v1/agents/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Update agent",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateAgentInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Agent updated",
      content: {
        "application/json": { schema: AgentResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/agents/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Delete agent",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Agent deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// GET /api/v1/agents/:id/versions
registry.registerPath({
  method: "get",
  path: "/api/v1/agents/{id}/versions",
  tags: ["Agents"],
  summary: "List agent versions",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ status: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Agent versions",
      content: {
        "application/json": { schema: z.array(AgentVersionSchema) },
      },
    },
  },
});

// POST /api/v1/agents/:id/versions
registry.registerPath({
  method: "post",
  path: "/api/v1/agents/{id}/versions",
  tags: ["Agents"],
  summary: "Register agent version (upsert)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: RegisterAgentVersionInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Version updated",
      content: {
        "application/json": { schema: AgentVersionSchema },
      },
    },
    201: {
      description: "Version created",
      content: {
        "application/json": { schema: AgentVersionSchema },
      },
    },
  },
});

// PATCH /api/v1/agents/:id/versions/:agentVersion
registry.registerPath({
  method: "patch",
  path: "/api/v1/agents/{id}/versions/{agentVersion}",
  tags: ["Agents"],
  summary: "Patch agent version",
  request: {
    params: z.object({ id: z.string(), agentVersion: z.string() }),
    body: {
      content: {
        "application/json": { schema: PatchAgentVersionInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Version updated",
      content: {
        "application/json": { schema: AgentVersionSchema },
      },
    },
  },
});
