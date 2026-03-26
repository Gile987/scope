// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  TokenInputSchema,
  TokenResponseSchema,
  ValidateTokenInputSchema,
} from "shared";

extendZodWithOpenApi(z);

// POST /api/v1/tokens/preview
registry.registerPath({
  method: "post",
  path: "/api/v1/tokens/preview",
  tags: ["Tokens"],
  summary: "Preview token",
  request: {
    body: {
      content: {
        "application/json": { schema: TokenInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Token preview",
      content: {
        "application/json": { schema: TokenResponseSchema },
      },
    },
  },
});

// POST /api/v1/tokens
registry.registerPath({
  method: "post",
  path: "/api/v1/tokens",
  tags: ["Tokens"],
  summary: "Create token",
  request: {
    body: {
      content: {
        "application/json": { schema: TokenInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Token created",
      content: {
        "application/json": { schema: TokenResponseSchema },
      },
    },
  },
});

// GET /api/v1/tokens
registry.registerPath({
  method: "get",
  path: "/api/v1/tokens",
  tags: ["Tokens"],
  summary: "List tokens",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(TokenResponseSchema) },
      },
    },
  },
});

// GET /api/v1/tokens/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/tokens/{id}",
  tags: ["Tokens"],
  summary: "Get token",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: TokenResponseSchema },
      },
    },
  },
});

// PUT /api/v1/tokens/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/tokens/{id}",
  tags: ["Tokens"],
  summary: "Update token",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: TokenInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Token updated",
      content: {
        "application/json": { schema: TokenResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/tokens/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/tokens/{id}",
  tags: ["Tokens"],
  summary: "Delete token",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Token deleted",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
  },
});

// POST /api/v1/tokens/:id/validate
registry.registerPath({
  method: "post",
  path: "/api/v1/tokens/{id}/validate",
  tags: ["Tokens"],
  summary: "Validate token",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: ValidateTokenInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Validation result",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("Token validation result"),
        },
      },
    },
  },
});
