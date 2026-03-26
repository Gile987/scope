// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateReportTemplateInputSchema,
  UpdateReportTemplateInputSchema,
  ReportTemplateResponseSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/report-templates/default-system-prompt
registry.registerPath({
  method: "get",
  path: "/api/v1/report-templates/default-system-prompt",
  tags: ["Report Templates"],
  summary: "Get default system prompt",
  responses: {
    200: {
      description: "Default system prompt",
      content: {
        "application/json": {
          schema: z.object({ systemPrompt: z.string() }),
        },
      },
    },
  },
});

// GET /api/v1/report-templates
registry.registerPath({
  method: "get",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "List report templates",
  request: {
    query: z.object({ search: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: z.array(ReportTemplateResponseSchema),
        },
      },
    },
  },
});

// GET /api/v1/report-templates/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/report-templates/{id}",
  tags: ["Report Templates"],
  summary: "Get report template",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: ReportTemplateResponseSchema },
      },
    },
  },
});

// POST /api/v1/report-templates
registry.registerPath({
  method: "post",
  path: "/api/v1/report-templates",
  tags: ["Report Templates"],
  summary: "Create report template",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateReportTemplateInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Report template created",
      content: {
        "application/json": { schema: ReportTemplateResponseSchema },
      },
    },
  },
});

// PUT /api/v1/report-templates/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/report-templates/{id}",
  tags: ["Report Templates"],
  summary: "Update report template",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateReportTemplateInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Report template updated",
      content: {
        "application/json": { schema: ReportTemplateResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/report-templates/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/report-templates/{id}",
  tags: ["Report Templates"],
  summary: "Delete report template",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Report template deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});
