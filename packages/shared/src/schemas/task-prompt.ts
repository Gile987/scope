// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PromptFeatureResultSchema } from "./prompt-feature.js";
import { PROMPT_TYPES } from "../types/types.js";

extendZodWithOpenApi(z);

export const PromptTypeSchema = z.enum(PROMPT_TYPES).openapi("PromptType");

export const CreateTaskPromptInputSchema = z
  .object({
    text: z.string(),
    type: PromptTypeSchema.optional(),
  })
  .openapi("CreateTaskPromptInput");

export const TaskPromptResponseSchema = z
  .object({
    _id: z.string(),
    type: PromptTypeSchema.optional(),
    // Present for inline-stored bodies; absent when the body lives in blob
    // storage (see `contentBlobUrl`). Use the `/content` endpoint to always
    // get the resolved text.
    text: z.string().optional(),
    contentBlobUrl: z.string().optional(),
    features: z.array(PromptFeatureResultSchema).optional(),
    featuresExtractedAt: z.coerce.date().optional(),
    createdAt: z.coerce.date(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("TaskPromptResponse");

export const PatchTaskPromptFeatureInputSchema = z
  .object({
    detected: z.boolean(),
  })
  .openapi("PatchTaskPromptFeatureInput");
