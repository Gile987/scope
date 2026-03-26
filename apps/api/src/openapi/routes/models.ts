// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  ModelResponseSchema,
  ModelSyncInputSchema,
  ListModelsQuerySchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/models
registry.registerPath({
  method: "get",
  path: "/api/v1/models",
  tags: ["Models"],
  summary: "List models",
  request: {
    query: ListModelsQuerySchema,
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(ModelResponseSchema) },
      },
    },
  },
});

// GET /api/v1/models/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/models/{id}",
  tags: ["Models"],
  summary: "Get model",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: ModelResponseSchema },
      },
    },
  },
});

// POST /api/v1/models/sync
registry.registerPath({
  method: "post",
  path: "/api/v1/models/sync",
  tags: ["Models"],
  summary: "Sync models from provider",
  request: {
    body: {
      content: {
        "application/json": { schema: ModelSyncInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Sync result",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("Model sync results"),
        },
      },
    },
  },
});
