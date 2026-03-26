// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const TokenInputSchema = z
  .object({})
  .passthrough()
  .openapi("TokenInput");

export const TokenResponseSchema = z
  .object({})
  .passthrough()
  .openapi("TokenResponse");

export const ValidateTokenInputSchema = z
  .object({
    token: z.string(),
  })
  .openapi("ValidateTokenInput");
