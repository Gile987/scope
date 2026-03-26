// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateCriteriaInputSchema,
  UpdateCriteriaInputSchema,
  CriteriaResponseSchema,
  CriteriaGraphSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/criteria/generate-prompt
registry.registerPath({
  method: "post",
  path: "/api/v1/criteria/generate-prompt",
  tags: ["Criteria"],
  summary: "Generate criterion prompt from behavior",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ behavior: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Generated prompt",
      content: {
        "application/json": {
          schema: z.object({ prompt: z.string() }),
        },
      },
    },
  },
});

// POST /api/v1/criteria/seed
registry.registerPath({
  method: "post",
  path: "/api/v1/criteria/seed",
  tags: ["Criteria"],
  summary: "Seed criteria in bulk",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            criteria: z.array(CreateCriteriaInputSchema),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Seed results",
      content: {
        "application/json": {
          schema: z.object({
            seeded: z.number(),
            skipped: z.number(),
            errors: z.number(),
          }),
        },
      },
    },
  },
});

// GET /api/v1/criteria
registry.registerPath({
  method: "get",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "List criteria",
  request: {
    query: z.object({ search: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(CriteriaResponseSchema) },
      },
    },
  },
});

// GET /api/v1/criteria/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/criteria/{id}",
  tags: ["Criteria"],
  summary: "Get criterion",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: CriteriaResponseSchema },
      },
    },
  },
});

// POST /api/v1/criteria
registry.registerPath({
  method: "post",
  path: "/api/v1/criteria",
  tags: ["Criteria"],
  summary: "Create criterion",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateCriteriaInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Criterion created",
      content: {
        "application/json": { schema: CriteriaResponseSchema },
      },
    },
  },
});

// PUT /api/v1/criteria/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/criteria/{id}",
  tags: ["Criteria"],
  summary: "Update criterion",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateCriteriaInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Criterion updated",
      content: {
        "application/json": { schema: CriteriaResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/criteria/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/criteria/{id}",
  tags: ["Criteria"],
  summary: "Soft-delete criterion",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Criterion deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// GET /api/v1/criteria/graph
registry.registerPath({
  method: "get",
  path: "/api/v1/criteria/graph",
  tags: ["Criteria"],
  summary: "Get criteria DAG",
  responses: {
    200: {
      description: "Directed acyclic graph of criteria",
      content: {
        "application/json": { schema: CriteriaGraphSchema },
      },
    },
  },
});

// GET /api/v1/criteria/mdp
registry.registerPath({
  method: "get",
  path: "/api/v1/criteria/mdp",
  tags: ["Criteria"],
  summary: "Compute MDP transitions",
  request: {
    query: z.object({ featureIds: z.string().optional() }),
  },
  responses: {
    200: {
      description: "MDP transition data",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("MDP transitions"),
        },
      },
    },
  },
});
