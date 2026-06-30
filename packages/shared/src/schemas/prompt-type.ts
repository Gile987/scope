// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PROMPT_TYPES } from "../types/types.js";

extendZodWithOpenApi(z);

// Defined in its own module so that `task-prompt.ts` and `prompt-feature.ts`
// can both depend on it without importing each other. Those two schema modules
// otherwise form an import cycle (task-prompt needs PromptFeatureResultSchema,
// prompt-feature needs PromptTypeSchema) that throws a temporal-dead-zone
// ReferenceError at ESM runtime depending on which side is evaluated first.
export const PromptTypeSchema = z.enum(PROMPT_TYPES).openapi("PromptType");
