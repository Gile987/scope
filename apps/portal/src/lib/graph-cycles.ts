// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dagre from "dagre";

export interface CycleGraphNode {
  id: string;
}

export interface CycleGraphEdge {
  source: string;
  target: string;
}

export interface CycleInfo {
  /** Every node that participates in a dependency cycle. */
  cycleNodes: Set<string>;
  /** Cyclic edges, keyed `${source}->${target}` to match the graph view. */
  cycleEdges: Set<string>;
  /** Each strongly-connected cycle as a list of node ids (for messaging). */
  cycleGroups: string[][];
}

/**
 * Identify every node and edge that participates in a dependency cycle.
 *
 * Backed by graphlib's `alg.findCycles` (Tarjan's strongly-connected
 * components), already available in the portal via `dagre` — so we don't
 * hand-roll the algorithm. `findCycles` returns the SCCs that actually contain
 * a cycle: components of size > 1, or a single node with a self-loop.
 *
 * A node is "in a cycle" iff it belongs to such an SCC. An edge is a cycle edge
 * iff both endpoints share that SCC (or it is a self-loop on a flagged node);
 * edges that merely *point into* a cycle from an acyclic node are not flagged.
 */
export function findCycles(nodes: CycleGraphNode[], edges: CycleGraphEdge[]): CycleInfo {
  const ids = new Set(nodes.map((n) => n.id));
  const g = new dagre.graphlib.Graph();
  for (const id of ids) g.setNode(id, {});
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  const cycleGroups = dagre.graphlib.alg.findCycles(g);

  const sccOf = new Map<string, number>();
  const cycleNodes = new Set<string>();
  cycleGroups.forEach((group, i) => {
    for (const id of group) {
      sccOf.set(id, i);
      cycleNodes.add(id);
    }
  });

  const cycleEdges = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target) {
      if (cycleNodes.has(e.source)) cycleEdges.add(`${e.source}->${e.target}`);
      continue;
    }
    const a = sccOf.get(e.source);
    const b = sccOf.get(e.target);
    if (a !== undefined && a === b) {
      cycleEdges.add(`${e.source}->${e.target}`);
    }
  }

  return { cycleNodes, cycleEdges, cycleGroups };
}
