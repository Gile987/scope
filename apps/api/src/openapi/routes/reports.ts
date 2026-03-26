// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateReportInputSchema,
  ReportResponseSchema,
  BulkCreateReportsInputSchema,
  BulkReportStatusInputSchema,
  TriggerReportsInputSchema,
  BulkTriggerReportsInputSchema,
  InsightResponseSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/reports
registry.registerPath({
  method: "post",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "Create report",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateReportInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Report created",
      content: {
        "application/json": { schema: ReportResponseSchema },
      },
    },
  },
});

// GET /api/v1/reports
registry.registerPath({
  method: "get",
  path: "/api/v1/reports",
  tags: ["Reports"],
  summary: "List reports",
  request: {
    query: z.object({ requestId: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(ReportResponseSchema) },
      },
    },
  },
});

// POST /api/v1/reports/bulk-create
registry.registerPath({
  method: "post",
  path: "/api/v1/reports/bulk-create",
  tags: ["Reports"],
  summary: "Bulk create reports",
  request: {
    body: {
      content: {
        "application/json": { schema: BulkCreateReportsInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Reports created",
      content: {
        "application/json": { schema: z.array(ReportResponseSchema) },
      },
    },
  },
});

// POST /api/v1/reports/bulk-status
registry.registerPath({
  method: "post",
  path: "/api/v1/reports/bulk-status",
  tags: ["Reports"],
  summary: "Bulk get report statuses",
  request: {
    body: {
      content: {
        "application/json": { schema: BulkReportStatusInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Report statuses",
      content: {
        "application/json": { schema: z.array(ReportResponseSchema) },
      },
    },
  },
});

// GET /api/v1/reports/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/reports/{id}",
  tags: ["Reports"],
  summary: "Get report",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: ReportResponseSchema },
      },
    },
  },
});

// GET /api/v1/reports/:id/logs
registry.registerPath({
  method: "get",
  path: "/api/v1/reports/{id}/logs",
  tags: ["Reports"],
  summary: "Stream report logs (SSE)",
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

// GET /api/v1/requests/:id/reports
registry.registerPath({
  method: "get",
  path: "/api/v1/requests/{id}/reports",
  tags: ["Reports"],
  summary: "Get reports for request",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Reports for the request",
      content: {
        "application/json": { schema: z.array(ReportResponseSchema) },
      },
    },
  },
});

// POST /api/v1/reports/trigger
registry.registerPath({
  method: "post",
  path: "/api/v1/reports/trigger",
  tags: ["Reports"],
  summary: "Trigger reports",
  request: {
    body: {
      content: {
        "application/json": { schema: TriggerReportsInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Triggered reports",
      content: {
        "application/json": {
          schema: z.object({
            triggered: z.array(ReportResponseSchema),
          }),
        },
      },
    },
  },
});

// POST /api/v1/reports/bulk-trigger
registry.registerPath({
  method: "post",
  path: "/api/v1/reports/bulk-trigger",
  tags: ["Reports"],
  summary: "Bulk trigger reports",
  request: {
    body: {
      content: {
        "application/json": { schema: BulkTriggerReportsInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Bulk trigger results",
      content: {
        "application/json": {
          schema: z.array(z.object({}).passthrough()),
        },
      },
    },
  },
});

// GET /api/v1/reports/:id/insights
registry.registerPath({
  method: "get",
  path: "/api/v1/reports/{id}/insights",
  tags: ["Reports"],
  summary: "Get insights referenced by report",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Insights for the report",
      content: {
        "application/json": { schema: z.array(InsightResponseSchema) },
      },
    },
  },
});

// POST /api/v1/reports/:id/insights
registry.registerPath({
  method: "post",
  path: "/api/v1/reports/{id}/insights",
  tags: ["Reports"],
  summary: "Add insight reference to report",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            insightId: z.string(),
            isNew: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Report updated with insight reference",
      content: {
        "application/json": { schema: ReportResponseSchema },
      },
    },
  },
});
