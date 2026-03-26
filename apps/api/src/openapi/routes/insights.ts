// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateInsightInputSchema,
  UpdateInsightInputSchema,
  InsightResponseSchema,
  ReportResponseSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/insights
registry.registerPath({
  method: "get",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "List insights",
  request: {
    query: z.object({
      q: z.string().optional(),
      blocked: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(InsightResponseSchema) },
      },
    },
  },
});

// GET /api/v1/insights/search
registry.registerPath({
  method: "get",
  path: "/api/v1/insights/search",
  tags: ["Insights"],
  summary: "Search insights",
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
        "application/json": { schema: z.array(InsightResponseSchema) },
      },
    },
  },
});

// GET /api/v1/insights/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/insights/{id}",
  tags: ["Insights"],
  summary: "Get insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// POST /api/v1/insights
registry.registerPath({
  method: "post",
  path: "/api/v1/insights",
  tags: ["Insights"],
  summary: "Create insight",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateInsightInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Insight created",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// PUT /api/v1/insights/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/insights/{id}",
  tags: ["Insights"],
  summary: "Update insight",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateInsightInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Insight updated",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/insights/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/insights/{id}",
  tags: ["Insights"],
  summary: "Delete insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insight deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// POST /api/v1/insights/:id/upvote
registry.registerPath({
  method: "post",
  path: "/api/v1/insights/{id}/upvote",
  tags: ["Insights"],
  summary: "Upvote insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insight upvoted",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// POST /api/v1/insights/:id/downvote
registry.registerPath({
  method: "post",
  path: "/api/v1/insights/{id}/downvote",
  tags: ["Insights"],
  summary: "Downvote insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insight downvoted",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// POST /api/v1/insights/:id/block
registry.registerPath({
  method: "post",
  path: "/api/v1/insights/{id}/block",
  tags: ["Insights"],
  summary: "Block insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insight blocked",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// POST /api/v1/insights/:id/unblock
registry.registerPath({
  method: "post",
  path: "/api/v1/insights/{id}/unblock",
  tags: ["Insights"],
  summary: "Unblock insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insight unblocked",
      content: {
        "application/json": { schema: InsightResponseSchema },
      },
    },
  },
});

// GET /api/v1/insights/:id/reports
registry.registerPath({
  method: "get",
  path: "/api/v1/insights/{id}/reports",
  tags: ["Insights"],
  summary: "Get reports referencing insight",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Reports referencing this insight",
      content: {
        "application/json": { schema: z.array(ReportResponseSchema) },
      },
    },
  },
});
