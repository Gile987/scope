// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  GateConfig,
  GateId,
  GATES,
  GATE_ORDER,
  isGateId,
} from "../types/types.js";

/**
 * Gates — pure helpers for the multi-phase evaluation pipeline.
 *
 * See docs/design/gates.md. These helpers contain no I/O: callers resolve
 * criteria / prompts from their stores and pass the data in.
 */

/**
 * Whether a criterion (with the given compatibility list) is compatible with a
 * gate. Empty/undefined `gates` means "all gates" (the new-criterion default).
 */
export function isCriterionCompatibleWithGate(
  criterionGates: GateId[] | undefined,
  gate: GateId,
): boolean {
  if (!criterionGates || criterionGates.length === 0) return true;
  return criterionGates.includes(gate);
}

/**
 * The downward-closed compatibility invariant: a parent must be compatible with
 * at least every gate its child is compatible with. Empty/undefined = the
 * universal set, so an unrestricted parent always satisfies the invariant.
 *
 * Returns true when `parentGates ⊇ childGates`.
 */
export function gatesSatisfyInvariant(
  parentGates: GateId[] | undefined,
  childGates: GateId[] | undefined,
): boolean {
  // Parent unrestricted ⇒ universal set ⇒ always a superset.
  if (!parentGates || parentGates.length === 0) return true;
  // Parent restricted but child unrestricted ⇒ child is the universal set,
  // which the restricted parent cannot be a superset of.
  if (!childGates || childGates.length === 0) return false;
  const parentSet = new Set(parentGates);
  return childGates.every((g) => parentSet.has(g));
}

/**
 * Normalise a request's gate configuration. When `gates` is absent or empty the
 * request is normalised to a single Select gate built from the legacy fields
 * (`scenario.criteria` + `maxIterations` + `taskPromptId`). See §4.3.
 */
export function normalizeGates(input: {
  gates?: GateConfig[];
  scenarioCriteria?: string[];
  maxIterations?: number;
  taskPromptId?: string;
}): GateConfig[] {
  if (input.gates && input.gates.length > 0) {
    return orderGates(input.gates);
  }
  return [
    {
      gate: "select",
      promptId: input.taskPromptId ?? "",
      criteria: input.scenarioCriteria ?? [],
      ...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
    },
  ];
}

/** Sort gate configs into canonical execution order (GATE_ORDER). */
export function orderGates(gates: GateConfig[]): GateConfig[] {
  const indexOf = (g: GateId) => GATE_ORDER.indexOf(g);
  return [...gates].sort((a, b) => indexOf(a.gate) - indexOf(b.gate));
}

/**
 * Validate the shape of a request's gate configs without touching any store.
 * Checks: known gate ids, no duplicate gates, and the criteria-count rule
 * (≥1 criterion unless the gate's effective maxIterations === 1).
 *
 * Returns an array of human-readable error strings (empty = valid). Store-backed
 * checks (criterion existence, compatibility, prompt type, the dependency
 * invariant) are layered on by the caller at submit time.
 */
export function validateGateConfigs(
  gates: GateConfig[],
  defaultMaxIterations?: number,
): string[] {
  const errors: string[] = [];
  const seen = new Set<GateId>();

  for (const gc of gates) {
    if (!isGateId(gc.gate)) {
      errors.push(`Unknown gate '${String(gc.gate)}'. Valid gates: ${GATES.join(", ")}.`);
      continue;
    }
    if (seen.has(gc.gate)) {
      errors.push(`Gate '${gc.gate}' is configured more than once.`);
    }
    seen.add(gc.gate);

    const effectiveMax = gc.maxIterations ?? defaultMaxIterations;
    const criteriaCount = gc.criteria?.length ?? 0;
    if (criteriaCount === 0 && effectiveMax !== 1) {
      errors.push(
        `Gate '${gc.gate}' must select at least one criterion unless its maxIterations is 1 ` +
          `(got maxIterations=${effectiveMax ?? "default"}).`,
      );
    }
  }

  return errors;
}
