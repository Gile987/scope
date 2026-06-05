// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import type { CodingAgentDocument } from "shared";

export type AgentModelValidationFailure =
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string; supportedModels?: string[] };

export type AgentModelValidationSuccess = {
  ok: true;
  agent: CodingAgentDocument;
};

export type AgentModelValidationResult = AgentModelValidationSuccess | AgentModelValidationFailure;

/**
 * Validates that an agent exists, exposes selectable models, and that the
 * requested model is one of them. Used by profile create / new-version
 * endpoints to enforce that a profile is self-sufficient (i.e. always
 * carries a model an agent actually supports).
 *
 * @param subjectPlural Used in the "no supportedModels" error message to
 * describe what's being rejected (e.g. "profiles", "profile versions").
 */
export async function validateAgentForModel(
  agentCollection: Collection<CodingAgentDocument>,
  workerType: string,
  model: string,
  subjectPlural: string,
): Promise<AgentModelValidationResult> {
  const agent = await agentCollection.findOne({ _id: workerType, deletedAt: { $exists: false } });
  if (!agent) {
    return { ok: false, status: 404, error: `Agent not found: ${workerType}` };
  }
  if (!agent.supportedModels || agent.supportedModels.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `Agent "${workerType}" does not declare any supportedModels; ${subjectPlural} cannot be created for it.`,
    };
  }
  if (!agent.supportedModels.includes(model)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid model "${model}" for agent "${workerType}"`,
      supportedModels: agent.supportedModels,
    };
  }
  return { ok: true, agent };
}
