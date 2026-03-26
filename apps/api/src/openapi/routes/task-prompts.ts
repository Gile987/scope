// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreateTaskPromptInputSchema,
  TaskPromptResponseSchema,
  PatchTaskPromptFeatureInputSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/task-prompts/generate
registry.registerPath({
  method: "post",
  path: "/api/v1/task-prompts/generate",
  tags: ["Task Prompts"],
  summary: "Generate task prompts",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            count: z.number().optional(),
            topic: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Generated tasks",
      content: {
        "application/json": {
          schema: z.object({ tasks: z.array(z.string()) }),
        },
      },
    },
  },
});

// GET /api/v1/task-prompts
registry.registerPath({
  method: "get",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "List task prompts",
  request: {
    query: z.object({
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(TaskPromptResponseSchema) },
      },
    },
  },
});

// GET /api/v1/task-prompts/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/task-prompts/{id}",
  tags: ["Task Prompts"],
  summary: "Get task prompt",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: TaskPromptResponseSchema },
      },
    },
  },
});

// POST /api/v1/task-prompts
registry.registerPath({
  method: "post",
  path: "/api/v1/task-prompts",
  tags: ["Task Prompts"],
  summary: "Create or find task prompt",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateTaskPromptInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Existing task prompt found",
      content: {
        "application/json": { schema: TaskPromptResponseSchema },
      },
    },
    201: {
      description: "Task prompt created",
      content: {
        "application/json": { schema: TaskPromptResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/task-prompts/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/task-prompts/{id}",
  tags: ["Task Prompts"],
  summary: "Soft-delete task prompt",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Task prompt deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// POST /api/v1/task-prompts/:id/extract-features
registry.registerPath({
  method: "post",
  path: "/api/v1/task-prompts/{id}/extract-features",
  tags: ["Task Prompts"],
  summary: "Extract features from task prompt",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Task prompt with extracted features",
      content: {
        "application/json": { schema: TaskPromptResponseSchema },
      },
    },
  },
});

// PATCH /api/v1/task-prompts/:id/features/:featureId
registry.registerPath({
  method: "patch",
  path: "/api/v1/task-prompts/{id}/features/{featureId}",
  tags: ["Task Prompts"],
  summary: "Toggle feature flag on task prompt",
  request: {
    params: z.object({ id: z.string(), featureId: z.string() }),
    body: {
      content: {
        "application/json": { schema: PatchTaskPromptFeatureInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Task prompt updated",
      content: {
        "application/json": { schema: TaskPromptResponseSchema },
      },
    },
  },
});
