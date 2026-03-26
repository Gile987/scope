// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

export const registry = new OpenAPIRegistry();

export function generateOpenAPIDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Scope MT API",
      version: "1.0.0",
      description:
        "REST API for the Scope MT platform — benchmarking AI coding agents",
    },
    servers: [{ url: "/", description: "Current server" }],
  });
}
