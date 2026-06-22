// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ConversationTurn,
  GateId,
  GateRunSummary,
} from "../types/types.js";
import { orderGates } from "../gates/gates.js";
import {
  MultiTurnConfig,
  MultiTurnResult,
  runMultiTurnLoop,
} from "./multi-turn-loop.js";

/**
 * A gate resolved for execution: the prompt text that drives the agent for the
 * gate, the criterion ids evaluated for it, and the gate's iteration budget.
 *
 * The caller is responsible for resolving `GateConfig.promptId` → `promptText`
 * (for the Select gate this is the scenario task) and for resolving the
 * effective `maxIterations` (per-gate budget or the request default).
 */
export interface ResolvedGate {
  gate: GateId;
  /** The prompt text driving the agent for this gate. */
  promptText: string;
  /** Criterion ids evaluated for this gate. Empty ⇒ pass-through (maxIterations must be 1). */
  criteria?: string[];
  /** Effective per-gate iteration budget. */
  maxIterations: number;
}

/**
 * Configuration for {@link runGatedLoop}. Shares the per-iteration infrastructure
 * of {@link MultiTurnConfig} but replaces the single `task` / `criteria` /
 * `maxIterations` / `gate` triple with an ordered list of resolved gates.
 */
export interface GatedLoopConfig
  extends Omit<
    MultiTurnConfig,
    "task" | "criteria" | "maxIterations" | "gate" | "iterationOffset"
  > {
  /** Gates to run, in any order (sorted into GATE_ORDER internally). */
  gates: ResolvedGate[];
  /** Called after each gate completes so the caller can persist a summary. */
  onGateComplete?: (summary: GateRunSummary) => Promise<void>;
}

/** Result of a gated run: the standard multi-turn result plus per-gate summaries. */
export interface GatedLoopResult extends MultiTurnResult {
  gateSummaries: GateRunSummary[];
}

/**
 * Runs the multi-phase gate pipeline (docs/design/gates.md §4.4).
 *
 * Gates run sequentially in `GATE_ORDER` against the **same** workspace. Each
 * gate runs the existing per-iteration coding + judge loop ({@link runMultiTurnLoop})
 * with the gate's own prompt, criteria, and iteration budget. The pipeline
 * **stops on the first gate failure** — every later gate is marked `skipped`.
 *
 * A run succeeds only if **every executed gate passes**.
 */
export async function runGatedLoop(
  config: GatedLoopConfig,
): Promise<GatedLoopResult> {
  const { gates, onGateComplete, log, ...shared } = config;

  const orderedGates = orderGates(
    gates.map((g) => ({
      gate: g.gate,
      promptId: "",
      criteria: g.criteria ?? [],
      maxIterations: g.maxIterations,
    })),
  ).map((oc) => gates.find((g) => g.gate === oc.gate)!);

  const allTurns: ConversationTurn[] = [];
  const gateSummaries: GateRunSummary[] = [];
  let iterationOffset = 0;
  let pipelinePassed = true;
  let pipelineHadError = false;
  let finalResult = "";
  let failedGate: GateId | undefined;

  await log("info", `Starting gated run (${orderedGates.length} gate(s): ${orderedGates.map((g) => g.gate).join(" → ")})`, {
    gates: orderedGates.map((g) => g.gate),
  });

  for (let gi = 0; gi < orderedGates.length; gi++) {
    const g = orderedGates[gi];

    // Stop-on-failure: once a gate fails, every downstream gate is skipped.
    if (failedGate) {
      const summary: GateRunSummary = { gate: g.gate, status: "skipped", iterations: 0 };
      gateSummaries.push(summary);
      if (onGateComplete) await onGateComplete(summary);
      await log("warn", `Gate '${g.gate}' skipped (a previous gate failed)`, {
        gate: g.gate,
        skippedAfter: failedGate,
      });
      continue;
    }

    await log("info", `=== Gate '${g.gate}' starting (max ${g.maxIterations} iteration(s)) ===`, {
      gate: g.gate,
      gateHeader: true,
      criteria: g.criteria ?? [],
    });

    const gateResult = await runMultiTurnLoop({
      ...shared,
      log,
      task: g.promptText,
      criteria: g.criteria,
      maxIterations: g.maxIterations,
      gate: g.gate,
      iterationOffset,
    });

    allTurns.push(...gateResult.turns);
    iterationOffset += gateResult.turns.length;
    finalResult = gateResult.finalResult;

    const summary: GateRunSummary = {
      gate: g.gate,
      status: gateResult.passed ? "passed" : "failed",
      iterations: gateResult.turns.length,
    };
    gateSummaries.push(summary);
    if (onGateComplete) await onGateComplete(summary);

    if (gateResult.passed) {
      await log("info", `=== Gate '${g.gate}' PASSED ===`, { gate: g.gate });
    } else {
      pipelinePassed = false;
      pipelineHadError = gateResult.hadError;
      failedGate = g.gate;
      await log(
        gateResult.hadError ? "error" : "warn",
        `=== Gate '${g.gate}' FAILED${gateResult.hadError ? " (error)" : ""} — stopping pipeline ===`,
        { gate: g.gate, downstreamSkipped: orderedGates.slice(gi + 1).map((x) => x.gate) },
      );
    }
  }

  return {
    turns: allTurns,
    passed: pipelinePassed,
    hadError: pipelineHadError,
    finalResult: failedGate
      ? `Gate '${failedGate}' failed: ${finalResult}`
      : finalResult,
    gateSummaries,
  };
}
