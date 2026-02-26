// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Client-side MDP utilities for incremental merging and graph topology hashing.
 */

import type { MdpResponse, MdpTransitionEdge, MdpStateNode } from "@/types";

/**
 * Merge a delta MDP response into an existing one.
 * Nodes are merged by ID (visits summed), edges by source+target (counts summed),
 * probabilities recomputed.
 */
export function mergeMdpResponses(
  existing: MdpResponse,
  delta: MdpResponse
): MdpResponse {
  // Nothing to merge if delta has no episodes
  if (delta.episodeCount === 0) {
    return { ...existing, computedAt: delta.computedAt };
  }

  // Merge nodes
  const nodesMap = new Map<string, MdpStateNode>();
  for (const node of existing.nodes) {
    nodesMap.set(node.id, { ...node });
  }
  for (const node of delta.nodes) {
    const prev = nodesMap.get(node.id);
    if (prev) {
      prev.visits += node.visits;
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
    selectedCriteria: delta.selectedCriteria,
    computedAt: delta.computedAt,
  };
}

/**
 * Compute a hash of the graph topology (node IDs + edge source/target pairs).
 * Used to decide whether to re-run dagre layout (skip if topology unchanged).
 */
export function topologyHash(data: MdpResponse): string {
  const nodeIds = data.nodes.map((n) => n.id).sort();
  const edgeKeys = data.edges.map((e) => `${e.source}->${e.target}`).sort();
  return `${nodeIds.join(",")}|${edgeKeys.join(",")}`;
}
