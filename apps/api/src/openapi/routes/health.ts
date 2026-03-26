// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";

extendZodWithOpenApi(z);

// GET /health
registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Liveness probe",
  responses: {
    200: {
      description: "Service is alive",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }),
        },
      },
    },
  },
});

// GET /ready
registry.registerPath({
  method: "get",
  path: "/ready",
  tags: ["Health"],
  summary: "Readiness probe",
  responses: {
    200: {
      description: "Service is ready",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            migrations: z.string(),
          }),
        },
      },
    },
    503: {
      description: "Service is not ready",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("not ready") }),
        },
      },
    },
  },
});

// GET /about
registry.registerPath({
  method: "get",
  path: "/about",
  tags: ["Health"],
  summary: "API metadata",
  responses: {
    200: {
      description: "API metadata",
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            version: z.string(),
            description: z.string(),
          }),
        },
      },
    },
  },
});

// GET /api/v1/version
registry.registerPath({
  method: "get",
  path: "/api/v1/version",
  tags: ["Health"],
  summary: "Version info",
  responses: {
    200: {
      description: "Version information",
      content: {
        "application/json": {
          schema: z.object({
            commit: z.string(),
            buildTime: z.string(),
            environment: z.string(),
            nodeVersion: z.string(),
            platform: z.string(),
            arch: z.string(),
          }),
        },
      },
    },
  },
});
