// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const GATES = ["select", "build", "test", "run", "deploy"] as const;
export type GateId = (typeof GATES)[number];
export type PromptType = GateId;

export const GATE_ORDER: readonly GateId[] = GATES;

/**
 * Gates whose portal visibility is gated behind a feature flag. A gate listed
 * here is hidden from authoring/selection surfaces unless its flag is explicitly
 * enabled (fail-closed — hidden while flags load or when the flag is missing/off).
 * Gates not listed here are always visible.
 */
export const GATE_FEATURE_FLAGS: Partial<Record<GateId, string>> = {
  run: "gates-run",
  deploy: "gates-deploy",
};

/**
 * Returns the ordered gate list with flag-controlled gates removed unless their
 * mapped flag is explicitly enabled. Pure helper — `enabledFlags` maps a flag
 * key to its enabled state (absent key ⇒ treated as disabled ⇒ gate hidden).
 */
export function visibleGateOrder(enabledFlags: Record<string, boolean>): GateId[] {
  return GATE_ORDER.filter((gate) => {
    const flagKey = GATE_FEATURE_FLAGS[gate];
    if (!flagKey) return true;
    return enabledFlags[flagKey] === true;
  });
}

export interface GateMetadata {
  id: GateId;
  label: string;
  description: string;
}

export const GATE_METADATA: Record<GateId, GateMetadata> = {
  select: {
    id: "select",
    label: "Requirements",
    description: "Agent implements the task (current behaviour).",
  },
  build: {
    id: "build",
    label: "Build",
    description: "Project builds / compiles successfully.",
  },
  test: {
    id: "test",
    label: "Test",
    description: "Tests pass.",
  },
  run: {
    id: "run",
    label: "Run",
    description: "App runs / serves correctly.",
  },
  deploy: {
    id: "deploy",
    label: "Deploy",
    description: "Deploys to the target environment.",
  },
};

export interface GateConfig {
  gate: GateId;
  promptId?: string;
  /** Input-only free-text gate prompt; materialized server-side into a typed prompt. */
  promptText?: string;
  criteria: string[];
  maxIterations?: number;
}

export interface GateRunSummary {
  gate: GateId;
  status: "passed" | "failed" | "skipped";
  iterations: number;
}

export function isGateId(value: unknown): value is GateId {
  return typeof value === "string" && (GATES as readonly string[]).includes(value);
}

export function isCriterionCompatibleWithGate(
  criterionGates: GateId[] | undefined,
  gate: GateId,
): boolean {
  if (!criterionGates || criterionGates.length === 0) return true;
  return criterionGates.includes(gate);
}

export function gatesSatisfyInvariant(
  parentGates: GateId[] | undefined,
  childGates: GateId[] | undefined,
): boolean {
  if (!parentGates || parentGates.length === 0) return true;
  if (!childGates || childGates.length === 0) return false;
  const parentSet = new Set(parentGates);
  return childGates.every((g) => parentSet.has(g));
}

export function orderGates(gates: GateConfig[]): GateConfig[] {
  const indexOf = (g: GateId) => GATE_ORDER.indexOf(g);
  return [...gates].sort((a, b) => indexOf(a.gate) - indexOf(b.gate));
}

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

export function formatGateList(gates: readonly GateId[] | undefined): string {
  if (!gates || gates.length === 0) return "All gates";
  return orderGateIds(gates).map((gate) => GATE_METADATA[gate].label).join(", ");
}

export function orderGateIds(gates: readonly GateId[]): GateId[] {
  return [...gates].sort((a, b) => GATE_ORDER.indexOf(a) - GATE_ORDER.indexOf(b));
}
