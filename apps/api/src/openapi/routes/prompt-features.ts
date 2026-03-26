// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  CreatePromptFeatureInputSchema,
  UpdatePromptFeatureInputSchema,
  PromptFeatureResponseSchema,
  PromptFeatureExtractionResponseSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/prompt-features/generate-prompt
registry.registerPath({
  method: "post",
  path: "/api/v1/prompt-features/generate-prompt",
  tags: ["Prompt Features"],
  summary: "Generate prompt feature from behavior",
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

// POST /api/v1/prompt-features/seed
registry.registerPath({
  method: "post",
  path: "/api/v1/prompt-features/seed",
  tags: ["Prompt Features"],
  summary: "Seed prompt features in bulk",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            features: z.array(CreatePromptFeatureInputSchema),
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

// GET /api/v1/prompt-features
registry.registerPath({
  method: "get",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "List features",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: z.array(PromptFeatureResponseSchema),
        },
      },
    },
  },
});

// GET /api/v1/prompt-features/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/prompt-features/{id}",
  tags: ["Prompt Features"],
  summary: "Get feature",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: PromptFeatureResponseSchema },
      },
    },
  },
});

// POST /api/v1/prompt-features
registry.registerPath({
  method: "post",
  path: "/api/v1/prompt-features",
  tags: ["Prompt Features"],
  summary: "Create feature",
  request: {
    body: {
      content: {
        "application/json": { schema: CreatePromptFeatureInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Feature created",
      content: {
        "application/json": { schema: PromptFeatureResponseSchema },
      },
    },
  },
});

// PUT /api/v1/prompt-features/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/prompt-features/{id}",
  tags: ["Prompt Features"],
  summary: "Update feature",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdatePromptFeatureInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Feature updated",
      content: {
        "application/json": { schema: PromptFeatureResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/prompt-features/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/prompt-features/{id}",
  tags: ["Prompt Features"],
  summary: "Soft-delete feature",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Feature deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
  },
});

// POST /api/v1/prompt-features/extract-from-text
registry.registerPath({
  method: "post",
  path: "/api/v1/prompt-features/extract-from-text",
  tags: ["Prompt Features"],
  summary: "Extract features from text",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            text: z.string(),
            features: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Extracted features",
      content: {
        "application/json": {
          schema: PromptFeatureExtractionResponseSchema,
        },
      },
    },
  },
});
