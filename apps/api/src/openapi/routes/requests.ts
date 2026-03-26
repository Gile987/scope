// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateRequestInputSchema,
  RequestResponseSchema,
  ListRequestsQuerySchema,
  BulkResubmitInputSchema,
  WorkerTypeSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/requests
registry.registerPath({
  method: "post",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "Submit request(s)",
  request: {
    query: z.object({
      worker: WorkerTypeSchema,
      count: z.coerce.number().min(1).max(10).optional(),
    }),
    body: {
      content: {
        "application/json": { schema: CreateRequestInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Request(s) created",
      content: {
        "application/json": {
          schema: z.union([
            RequestResponseSchema,
            z.array(RequestResponseSchema),
          ]),
        },
      },
    },
  },
});

// GET /api/v1/requests
registry.registerPath({
  method: "get",
  path: "/api/v1/requests",
  tags: ["Requests"],
  summary: "List requests",
  request: {
    query: ListRequestsQuerySchema,
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(RequestResponseSchema) },
      },
    },
  },
});

// GET /api/v1/requests/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}",
  tags: ["Requests"],
  summary: "Get request",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: RequestResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/requests/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/requests/{id}",
  tags: ["Requests"],
  summary: "Soft-delete request",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Request deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// DELETE /api/v1/requests/bulk
registry.registerPath({
  method: "delete",
  path: "/api/v1/requests/bulk",
  tags: ["Requests"],
  summary: "Bulk soft-delete requests",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ ids: z.array(z.string()) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Requests deleted",
      content: {
        "application/json": {
          schema: z.object({ deleted: z.number() }),
        },
      },
    },
  },
});

// POST /api/v1/requests/bulk-resubmit
registry.registerPath({
  method: "post",
  path: "/api/v1/requests/bulk-resubmit",
  tags: ["Requests"],
  summary: "Bulk resubmit requests",
  request: {
    body: {
      content: {
        "application/json": { schema: BulkResubmitInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Requests resubmitted",
      content: {
        "application/json": { schema: z.array(RequestResponseSchema) },
      },
    },
  },
});

// GET /api/v1/requests/:id/logs
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/logs",
  tags: ["Requests"],
  summary: "Stream request logs (SSE)",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Server-sent event stream of log entries",
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
    },
  },
});

// GET /api/v1/requests/:id/snapshots/:iteration
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/snapshots/{iteration}",
  tags: ["Requests"],
  summary: "Download iteration snapshot",
  request: {
    params: z.object({ id: z.string(), iteration: z.string() }),
  },
  responses: {
    200: {
      description: "Gzipped snapshot archive",
      content: {
        "application/gzip": {
          schema: z.string().describe("Binary gzip data"),
        },
      },
    },
  },
});

// GET /api/v1/requests/:id/archive
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/archive",
  tags: ["Requests"],
  summary: "Download full run archive",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Gzipped run archive",
      content: {
        "application/gzip": {
          schema: z.string().describe("Binary gzip data"),
        },
      },
    },
  },
});

// GET /api/v1/requests/:id/har
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/har",
  tags: ["Requests"],
  summary: "Download HAR file",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "HAR-format JSON file",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("HAR 1.2 format"),
        },
      },
    },
  },
});

// GET /api/v1/requests/:id/video
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/video",
  tags: ["Requests"],
  summary: "Download session recording",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "WebM video recording (supports Range requests)",
      content: {
        "video/webm": {
          schema: z.string().describe("Binary video data"),
        },
      },
    },
  },
});

// GET /api/v1/analysis
registry.registerPath({
  method: "get",
  path: "/api/v1/analysis",
  tags: ["Requests"],
  summary: "Compute pass@k / success@T metrics",
  request: {
    query: z.object({
      worker: z.string().optional(),
      taskPromptId: z.string().optional(),
      criteria: z.string().optional(),
      submissionId: z.string().optional(),
      k: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      description: "Analysis results",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("Analysis metrics"),
        },
      },
    },
  },
});

// POST /api/v1/runs/upload
registry.registerPath({
  method: "post",
  path: "/api/v1/runs/upload",
  tags: ["Requests"],
  summary: "Import run archive",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.string().describe("Archive file (gzip)"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Run imported",
      content: {
        "application/json": { schema: RequestResponseSchema },
      },
    },
  },
});
