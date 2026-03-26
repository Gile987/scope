// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import {
  FeatureFlagResponseSchema,
  UpdateFeatureFlagInputSchema,
} from "shared";

extendZodWithOpenApi(z);

// GET /api/v1/feature-flags
registry.registerPath({
  method: "get",
  path: "/api/v1/feature-flags",
  tags: ["Feature Flags"],
  summary: "List feature flags",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: z.array(FeatureFlagResponseSchema),
        },
      },
    },
  },
});

// PUT /api/v1/feature-flags/:key
registry.registerPath({
  method: "put",
  path: "/api/v1/feature-flags/{key}",
  tags: ["Feature Flags"],
  summary: "Update feature flag",
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateFeatureFlagInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Feature flag updated",
      content: {
        "application/json": { schema: FeatureFlagResponseSchema },
      },
    },
  },
});
