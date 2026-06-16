// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const PersonalitySchema = z.enum(["demanding", "friendly"]);
export const ExperienceSchema = z.enum(["junior", "senior"]);
export const VerbositySchema = z.enum(["brief", "moderate"]);
export const UserTypeSchema = z.enum(["traditional", "ai_assisted", "vibe"]);

export const PersonaSchema = z
  .object({
    personality: PersonalitySchema,
    experience: ExperienceSchema,
    verbosity: VerbositySchema,
    type: UserTypeSchema,
  })
  .openapi("Persona");

export const ServiceHealthCheckSchema = z.object({
  test: z.array(z.string()),
  intervalSeconds: z.number().positive(),
  timeoutSeconds: z.number().positive(),
  retries: z.number().int().positive(),
  startPeriodSeconds: z.number().nonnegative(),
}).openapi("ServiceHealthCheck");

export const ServicePortSchema = z.object({
  host: z.number().int().positive(),
  container: z.number().int().positive(),
}).openapi("ServicePort");

export const ServiceDeclarationSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  ports: z.array(ServicePortSchema).min(1),
  environment: z.record(z.string(), z.string()).optional(),
  healthCheck: ServiceHealthCheckSchema.optional(),
  envVars: z.record(z.string(), z.string()),
}).openapi("ServiceDeclaration");

export const ScenarioSchema = z
  .object({
    version: z.enum(["v1", "v2"]).optional(),
    task: z.string(),
    criteria: z.array(z.string()),
    services: z.array(ServiceDeclarationSchema).optional(),
  })
  .openapi("Scenario");
