// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateSkillInputSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
  SkillSearchResultSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/skills
registry.registerPath({
  method: "get",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "List skills",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(SkillResponseSchema) },
      },
    },
  },
});

// GET /api/v1/skills/search
registry.registerPath({
  method: "get",
  path: "/api/v1/skills/search",
  tags: ["Skills"],
  summary: "Search skills",
  request: {
    query: z.object({
      q: z.string(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": { schema: z.array(SkillSearchResultSchema) },
      },
    },
  },
});

// GET /api/v1/skills/search/external
registry.registerPath({
  method: "get",
  path: "/api/v1/skills/search/external",
  tags: ["Skills"],
  summary: "Search external skills",
  request: {
    query: z.object({
      q: z.string(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      description: "External search results",
      content: {
        "application/json": { schema: z.array(SkillSearchResultSchema) },
      },
    },
  },
});

// GET /api/v1/skills/{id}
registry.registerPath({
  method: "get",
  path: "/api/v1/skills/{id}",
  tags: ["Skills"],
  summary: "Get skill",
  request: {
    params: z.object({ id: z.string().describe("Skill slug (wildcard)") }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: SkillResponseSchema },
      },
    },
  },
});

// GET /api/v1/skills/{id}/revisions
registry.registerPath({
  method: "get",
  path: "/api/v1/skills/{id}/revisions",
  tags: ["Skills"],
  summary: "List skill revisions",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Skill revisions",
      content: {
        "application/json": { schema: z.array(SkillRevisionResponseSchema) },
      },
    },
  },
});

// POST /api/v1/skills
registry.registerPath({
  method: "post",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "Create skill",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateSkillInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Skill created",
      content: {
        "application/json": { schema: SkillResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/skills/{id}
registry.registerPath({
  method: "delete",
  path: "/api/v1/skills/{id}",
  tags: ["Skills"],
  summary: "Delete skill",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Skill deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// POST /api/v1/skills/{id}/resolve
registry.registerPath({
  method: "post",
  path: "/api/v1/skills/{id}/resolve",
  tags: ["Skills"],
  summary: "Trigger skill resolution",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Resolved skill revision",
      content: {
        "application/json": { schema: SkillRevisionResponseSchema },
      },
    },
  },
});
