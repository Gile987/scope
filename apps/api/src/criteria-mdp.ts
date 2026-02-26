// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MDP (Markov Decision Process) state transition module
 *
 * Computes a state-transition graph where:
 *   - Each node is a unique composite criteria state vector (pass/fail per criterion)
 *   - Each edge is a transition between states across consecutive iterations,
 *     labeled with a count and probability
 *   - An initial "all-failed" state is prepended to every episode
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-criterion state within a composite state vector */
export interface CriterionState {
  id: string;
  passed: boolean;
}

/** A node in the MDP graph — a unique composite state vector */
export interface MdpStateNode {
  /** Canonical string key (e.g. "has_azure:0|has_cloud:1|has_iac:0") */
  id: string;
  /** Sorted criteria states */
  criteria: CriterionState[];
  /** How many times any episode visited this state */
  visits: number;
  /** True for the synthetic all-failed initial state */
  isInitial?: boolean;
  /** True if no outgoing transitions exist (final state of some episodes) */
  isTerminal?: boolean;
}

/** An edge in the MDP graph — a transition between two states */
export interface MdpTransitionEdge {
  source: string;
  target: string;
  /** How many times this specific transition was observed */
  count: number;
  /** Probability: count / total outgoing from source */
  probability: number;
}

/** Full MDP response */
export interface MdpResponse {
  nodes: MdpStateNode[];
  edges: MdpTransitionEdge[];
  /** Total number of episodes (runs) that contributed */
  episodeCount: number;
  /** All criteria IDs found across all runs (before filtering) */
  availableCriteria: string[];
  /** Criteria IDs used for projection (empty = all) */
  selectedCriteria: string[];
  /** ISO timestamp of when this was computed — used for incremental polling */
  computedAt: string;
}

/** Minimal run shape needed for MDP computation (subset of RequestDocument) */
export interface MdpAnalyzableRun {
  scenario: { criteria?: string[] };
  status: string;
  updatedAt?: Date | string;
  turns?: Array<{
    iteration: number;
    criteriaResults?: Array<{
      criterionId: string;
      passed: boolean;
      evaluated: boolean;
    }>;
  }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a canonical state key from a criteria state vector.
 * Criteria are sorted alphabetically by ID so the key is deterministic.
 */
function stateKey(criteria: CriterionState[]): string {
  return criteria
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}:${c.passed ? 1 : 0}`)
    .join("|");
}

/**
 * Build a criteria state vector for a given turn.
 * `evaluated: false` is treated as `passed: false` (skipped = unmet).
 * Only criteria in `criteriaIds` are included.
 */
function buildStateVector(
  turn: NonNullable<MdpAnalyzableRun["turns"]>[number],
  criteriaIds: string[]
): CriterionState[] {
  const resultsMap = new Map(
    (turn.criteriaResults || []).map((r) => [r.criterionId, r])
  );
  return criteriaIds.map((id) => {
    const r = resultsMap.get(id);
    return { id, passed: r ? r.evaluated && r.passed : false };
  });
}

// ─── Core computation ────────────────────────────────────────────────────────

/**
 * Compute the MDP state-transition graph from a set of runs.
 *
 * @param runs  Completed/failed/exhausted runs with turns + criteriaResults
 * @param selectedCriteria  Optional subset of criteria to project to. If provided,
 *   only these criteria are included in the state vectors (producing a sub-MDP where
 *   states that only differed in excluded criteria are merged).
 */
export function computeMdp(
  runs: MdpAnalyzableRun[],
  selectedCriteria?: string[]
): MdpResponse {
  // Collect all criteria IDs across all runs
  const allCriteriaSet = new Set<string>();
  for (const run of runs) {
    if (run.scenario?.criteria) {
      for (const c of run.scenario.criteria) {
        allCriteriaSet.add(c);
      }
    }
    // Also collect from turns in case scenario.criteria is incomplete
    if (run.turns) {
      for (const turn of run.turns) {
        if (turn.criteriaResults) {
          for (const r of turn.criteriaResults) {
            allCriteriaSet.add(r.criterionId);
          }
        }
      }
    }
  }
  const availableCriteria = Array.from(allCriteriaSet).sort();

  // Determine which criteria to include in state vectors
  const projectionCriteria =
    selectedCriteria && selectedCriteria.length > 0
      ? selectedCriteria.slice().sort()
      : availableCriteria;

  // Filter runs: if selectedCriteria is provided, only include runs that have
  // at least one of the selected criteria (so the state vector is meaningful)
  const filteredRuns =
    selectedCriteria && selectedCriteria.length > 0
      ? runs.filter((run) => {
          const runCriteria = new Set<string>();
          if (run.scenario?.criteria) {
            for (const c of run.scenario.criteria) runCriteria.add(c);
          }
          if (run.turns) {
            for (const turn of run.turns) {
              if (turn.criteriaResults) {
                for (const r of turn.criteriaResults) runCriteria.add(r.criterionId);
              }
            }
          }
          return selectedCriteria.some((c) => runCriteria.has(c));
        })
      : runs;

  // Accumulators
  const nodesMap = new Map<string, MdpStateNode>();
  const edgesMap = new Map<string, { source: string; target: string; count: number }>();
  const outgoingCounts = new Map<string, number>(); // source -> total outgoing transitions

  // Build synthetic initial state (all criteria failed)
  const initialCriteria: CriterionState[] = projectionCriteria.map((id) => ({
    id,
    passed: false,
  }));
  const initialKey = stateKey(initialCriteria);

  let episodeCount = 0;

  for (const run of filteredRuns) {
    if (!run.turns || run.turns.length === 0) continue;

    // Ensure initial state node exists (created lazily on first episode)
    if (!nodesMap.has(initialKey)) {
      nodesMap.set(initialKey, {
        id: initialKey,
        criteria: initialCriteria,
        visits: 0,
        isInitial: true,
      });
    }

    // Sort turns by iteration
    const sortedTurns = run.turns.slice().sort((a, b) => a.iteration - b.iteration);

    // Build the sequence of state keys for this episode
    const states: string[] = [initialKey];
    const stateVectors: CriterionState[][] = [initialCriteria];

    for (const turn of sortedTurns) {
      const vec = buildStateVector(turn, projectionCriteria);
      const key = stateKey(vec);
      states.push(key);
      stateVectors.push(vec);

      // Ensure node exists
      if (!nodesMap.has(key)) {
        nodesMap.set(key, {
          id: key,
          criteria: vec.slice().sort((a, b) => a.id.localeCompare(b.id)),
          visits: 0,
        });
      }
    }

    // Record visits and transitions
    for (let i = 0; i < states.length; i++) {
      const node = nodesMap.get(states[i])!;
      node.visits++;

      if (i < states.length - 1) {
        const edgeKey = `${states[i]}||${states[i + 1]}`;
        const existing = edgesMap.get(edgeKey);
        if (existing) {
          existing.count++;
        } else {
          edgesMap.set(edgeKey, {
            source: states[i],
            target: states[i + 1],
            count: 1,
          });
        }
        outgoingCounts.set(
          states[i],
          (outgoingCounts.get(states[i]) || 0) + 1
        );
      }
    }

    episodeCount++;
  }

  // Mark terminal nodes (no outgoing transitions)
  for (const node of nodesMap.values()) {
    if (!outgoingCounts.has(node.id)) {
      node.isTerminal = true;
    }
  }

  // Build edges with probabilities
  const edges: MdpTransitionEdge[] = [];
  for (const edge of edgesMap.values()) {
    const totalOutgoing = outgoingCounts.get(edge.source) || 1;
    edges.push({
      source: edge.source,
      target: edge.target,
      count: edge.count,
      probability: edge.count / totalOutgoing,
    });
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
    episodeCount,
    availableCriteria,
    selectedCriteria: selectedCriteria || [],
    computedAt: new Date().toISOString(),
  };
}

// ─── Merge utility (for incremental updates) ─────────────────────────────────

/**
 * Merge a delta MDP response into an existing one.
 * Nodes are merged by ID (visits summed), edges by source+target (counts summed),
 * probabilities recomputed.
 */
export function mergeMdpResponses(
  existing: MdpResponse,
  delta: MdpResponse
): MdpResponse {
  // Merge nodes
  const nodesMap = new Map<string, MdpStateNode>();
  for (const node of existing.nodes) {
    nodesMap.set(node.id, { ...node });
  }
  for (const node of delta.nodes) {
    const prev = nodesMap.get(node.id);
    if (prev) {
      prev.visits += node.visits;
      // Keep isInitial if either has it
      if (node.isInitial) prev.isInitial = true;
    } else {
      nodesMap.set(node.id, { ...node });
    }
  }

  // Merge edges (sum counts)
  const edgesMap = new Map<string, MdpTransitionEdge>();
  for (const edge of existing.edges) {
    const key = `${edge.source}||${edge.target}`;
    edgesMap.set(key, { ...edge });
  }
  for (const edge of delta.edges) {
    const key = `${edge.source}||${edge.target}`;
    const prev = edgesMap.get(key);
    if (prev) {
      prev.count += edge.count;
    } else {
      edgesMap.set(key, { ...edge });
    }
  }

  // Recompute probabilities from merged counts
  const outgoingCounts = new Map<string, number>();
  for (const edge of edgesMap.values()) {
    outgoingCounts.set(
      edge.source,
      (outgoingCounts.get(edge.source) || 0) + edge.count
    );
  }
  for (const edge of edgesMap.values()) {
    const total = outgoingCounts.get(edge.source) || 1;
    edge.probability = edge.count / total;
  }

  // Recompute terminal status
  for (const node of nodesMap.values()) {
    node.isTerminal = !outgoingCounts.has(node.id);
  }

  // Merge available criteria
  const allCriteria = new Set([
    ...existing.availableCriteria,
    ...delta.availableCriteria,
  ]);

  return {
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values()),
    episodeCount: existing.episodeCount + delta.episodeCount,
    availableCriteria: Array.from(allCriteria).sort(),
    selectedCriteria: delta.selectedCriteria, // Use the latest selection
    computedAt: delta.computedAt,
  };
}
