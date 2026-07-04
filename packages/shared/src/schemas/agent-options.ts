// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/**
 * Per-worker agent options.
 *
 * An **agent option** is a user-customizable, agent-specific behavioral value
 * (e.g. autopilot mode). It is deliberately kept separate from
 * {@link AgentCapabilitiesSchema} gates such as `supportsReasoningEffort`:
 *
 * - A *capability gate* governs whether a worker can surface an underlying
 *   **model** dimension (reasoning effort is a property of the model; the flag
 *   only says "this worker can plumb it").
 * - An *option* is not a model property at all — it is an agent behavioral value
 *   the user picks, and its availability is purely a function of the worker.
 *
 * Each worker advertises the options it accepts through its `agent.yaml`
 * registration (an **options descriptor**). The portal renders that descriptor
 * dynamically (only what the selected worker supports) and the API validates
 * submitted option bags against it.
 */

/** Supported value types for an advertised agent option. */
export const AgentOptionTypeSchema = z.enum(["boolean", "string", "number", "enum"]);
export type AgentOptionType = z.infer<typeof AgentOptionTypeSchema>;

/**
 * Descriptor for a single option a worker advertises it accepts.
 * Advertised via `agent.yaml`, stored on the agent document, and returned to the
 * portal for dynamic rendering.
 */
export const AgentOptionDescriptorSchema = z
  .object({
    /** Option key used in the options bag (e.g. "autopilot"). */
    key: z.string(),
    /** Value type — drives portal control selection and API validation. */
    type: AgentOptionTypeSchema,
    /** Human-readable label for the portal control. */
    label: z.string(),
    /** Optional longer help text. */
    description: z.string().optional(),
    /** Default value applied when the user leaves the option unset. */
    default: z.unknown().optional(),
    /** Allowed values when `type` is "enum". */
    enum: z.array(z.string()).optional(),
  })
  .openapi("AgentOptionDescriptor");

export type AgentOptionDescriptor = z.infer<typeof AgentOptionDescriptorSchema>;

/** An array of advertised option descriptors for a worker. */
export const AgentOptionsDescriptorSchema = z.array(AgentOptionDescriptorSchema);

/** A resolved/submitted options bag carried on requests and profile versions. */
export const AgentOptionsSchema = z.record(z.string(), z.unknown());
export type AgentOptions = Record<string, unknown>;

/**
 * Canonical descriptor for the native autopilot option.
 *
 * Autopilot = **HITL autonomy** (run without pausing to ask the human). It is a
 * genuine per-worker user option — distinct from the always-on auto-approve /
 * permission-escalation plumbing, which is fixed worker infra and never
 * user-exposed.
 */
export const AUTOPILOT_OPTION_DESCRIPTOR: AgentOptionDescriptor = {
  key: "autopilot",
  type: "boolean",
  label: "Autopilot mode",
  description:
    "Run the agent in its native autopilot mode — fully autonomous, never pausing to ask clarifying questions. Off by default.",
  default: false,
};

/**
 * Canonical source-of-truth mapping of worker type → advertised option
 * descriptors. Each worker's `agent.yaml` mirrors this; the API and CLI fall
 * back to it when an agent document has not (yet) been re-seeded with its
 * descriptors.
 *
 * Copilot and VS Code workers support autopilot. Claude Code has no autopilot
 * equivalent — in headless ACP it is already autonomous — so it advertises
 * nothing on this axis (a submitted autopilot option is rejected for it).
 */
export const WORKER_AGENT_OPTIONS: Record<string, AgentOptionDescriptor[]> = {
  "coder-acp-copilot": [AUTOPILOT_OPTION_DESCRIPTOR],
  "coder-acp-copilot-windows": [AUTOPILOT_OPTION_DESCRIPTOR],
  "coder-vscode-web": [AUTOPILOT_OPTION_DESCRIPTOR],
  "coder-vscode-electron-driver-ext": [AUTOPILOT_OPTION_DESCRIPTOR],
  "coder-acp-claude-code": [],
};

/**
 * Resolve the option descriptors to use for a worker: prefer the descriptors
 * advertised on the agent document, else fall back to the canonical map.
 */
export function getAgentOptionDescriptors(
  workerType: string,
  advertised?: AgentOptionDescriptor[],
): AgentOptionDescriptor[] {
  if (advertised && advertised.length > 0) return advertised;
  return WORKER_AGENT_OPTIONS[workerType] ?? [];
}

/**
 * Build a strict zod validator for an options bag from advertised descriptors.
 * Unknown keys are rejected; each known key is validated against its declared
 * type. A worker that advertises no options therefore rejects any option.
 */
export function buildAgentOptionsSchema(
  descriptors: AgentOptionDescriptor[],
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const d of descriptors) {
    let field: z.ZodTypeAny;
    switch (d.type) {
      case "boolean":
        field = z.boolean();
        break;
      case "number":
        field = z.number();
        break;
      case "enum":
        field =
          d.enum && d.enum.length > 0
            ? z.enum(d.enum as [string, ...string[]])
            : z.string();
        break;
      case "string":
      default:
        field = z.string();
        break;
    }
    shape[d.key] = field.optional();
  }
  return z.strictObject(shape) as z.ZodType<Record<string, unknown>>;
}

export type ValidateAgentOptionsResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

/**
 * Validate a submitted options bag for a worker against its advertised
 * descriptors (falling back to the canonical map when none are advertised).
 * Returns the parsed bag on success or a human-readable error string.
 */
export function validateAgentOptions(
  workerType: string,
  options: Record<string, unknown> | undefined,
  advertised?: AgentOptionDescriptor[],
): ValidateAgentOptionsResult {
  if (options === undefined) return { success: true, data: {} };
  const descriptors = getAgentOptionDescriptors(workerType, advertised);
  const schema = buildAgentOptionsSchema(descriptors);
  const parsed = schema.safeParse(options);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { success: false, error: issues };
  }
  return { success: true, data: parsed.data };
}

/**
 * Per-key merge of request-level and profile-level option bags. Profile keys
 * override request keys — mirroring the controlled-field precedence used for
 * model / reasoningEffort / mcpServers / etc. Returns undefined when neither
 * side contributes any key (so callers can omit an empty field).
 */
export function mergeAgentOptions(
  requestOptions: Record<string, unknown> | undefined,
  profileOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!requestOptions && !profileOptions) return undefined;
  const merged = { ...(requestOptions ?? {}), ...(profileOptions ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
