// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const McpTransportTypeSchema = z.enum(["sse", "http"]);

export const McpServerHeaderSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .openapi("McpServerHeader");

export const CreateMcpServerInputSchema = z
  .object({
    name: z.string(),
    type: McpTransportTypeSchema,
    url: z.string(),
    headers: z.array(McpServerHeaderSchema).optional(),
    description: z.string().optional(),
  })
  .openapi("CreateMcpServerInput");

export const UpdateMcpServerInputSchema = z
  .object({
    name: z.string().optional(),
    type: McpTransportTypeSchema.optional(),
    url: z.string().optional(),
    headers: z.array(McpServerHeaderSchema).optional(),
    description: z.string().optional(),
  })
  .openapi("UpdateMcpServerInput");

export const McpServerResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    type: McpTransportTypeSchema,
    url: z.string(),
    headers: z.array(McpServerHeaderSchema).optional(),
    description: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("McpServerResponse");
