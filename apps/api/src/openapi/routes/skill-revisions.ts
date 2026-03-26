// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import { SkillRevisionResponseSchema } from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/skill-revisions/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/skill-revisions/{id}",
  tags: ["Skill Revisions"],
  summary: "Get skill revision",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: SkillRevisionResponseSchema },
      },
    },
  },
});

// GET /api/v1/skill-revisions/by-ref/{ref}
registry.registerPath({
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/{ref}",
  tags: ["Skill Revisions"],
  summary: "Get skill revision by ref",
  request: {
    params: z.object({ ref: z.string().describe("Skill revision ref (wildcard)") }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: SkillRevisionResponseSchema },
      },
    },
  },
});

// GET /api/v1/skill-revisions/by-ref/{ref}/archive
registry.registerPath({
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/{ref}/archive",
  tags: ["Skill Revisions"],
  summary: "Download skill revision archive",
  request: {
    params: z.object({ ref: z.string() }),
  },
  responses: {
    200: {
      description: "Gzipped skill revision archive",
      content: {
        "application/gzip": {
          schema: z.string().describe("Binary gzip data"),
        },
      },
    },
  },
});
