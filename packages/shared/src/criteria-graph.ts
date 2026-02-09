// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CriteriaConfig, CriterionResult } from './types.js';

/**
 * Criteria DAG (Directed Acyclic Graph) implementation
 *
 * Manages dependencies between criteria and provides graph traversal operations:
 * - Cycle detection (fail fast)
 * - Topological sort (evaluation order)
 * - Ancestor/descendant computation (transitive closure)
 * - Root failure filtering (failures without failing ancestors)
 */
export class CriteriaGraph {
  private registry: Map<string, CriteriaConfig>;
  private adjacencyList: Map<string, Set<string>>;      // parent -> children
  private reverseAdjacency: Map<string, Set<string>>;   // child -> parents

  constructor(criteria: CriteriaConfig[]) {
    this.registry = new Map();
    this.adjacencyList = new Map();
    this.reverseAdjacency = new Map();

    // Add all criteria to registry
    for (const criterion of criteria) {
      if (this.registry.has(criterion.id)) {
        throw new Error(`Duplicate criteria id '${criterion.id}'`);
      }
      this.registry.set(criterion.id, criterion);
      this.adjacencyList.set(criterion.id, new Set());
      this.reverseAdjacency.set(criterion.id, new Set());
    }

    // Build edges (parent -> child)
    for (const criterion of criteria) {
      if (criterion.dependsOn && criterion.dependsOn.length > 0) {
        for (const parentId of criterion.dependsOn) {
          if (!this.registry.has(parentId)) {
            throw new Error(
              `Criteria '${criterion.id}' depends on unknown criteria '${parentId}'`
            );
          }
          // Add edge: parent -> child
          this.adjacencyList.get(parentId)!.add(criterion.id);
          this.reverseAdjacency.get(criterion.id)!.add(parentId);
        }
      }
    }

    // Validate no cycles
    this.validateNoCycles();
  }

  /**
   * Validate no cycles using DFS with visited/visiting sets
   */
  private validateNoCycles(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (criterionId: string): boolean => {
      if (visiting.has(criterionId)) {
        // Found a cycle
        return true;
      }
      if (visited.has(criterionId)) {
        // Already processed
        return false;
      }

      visiting.add(criterionId);

      const children = this.adjacencyList.get(criterionId) || new Set();
      for (const childId of children) {
        if (dfs(childId)) {
          return true;  // Cycle detected
        }
      }

      visiting.delete(criterionId);
      visited.add(criterionId);
      return false;
    };

    // Check all nodes (handles disconnected components)
    for (const criterionId of this.registry.keys()) {
      if (!visited.has(criterionId)) {
        if (dfs(criterionId)) {
          throw new Error('Cycle detected in criteria dependencies');
        }
      }
    }
  }

  /**
   * Get all ancestor IDs (transitive) using BFS
   */
  getAncestors(criterionId: string): Set<string> {
    if (!this.registry.has(criterionId)) {
      return new Set();
    }

    const ancestors = new Set<string>();
    const queue: string[] = [];

    // Start with immediate parents
    const parents = this.reverseAdjacency.get(criterionId) || new Set();
    for (const parentId of parents) {
      queue.push(parentId);
      ancestors.add(parentId);
    }

    // BFS to get all transitive ancestors
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentParents = this.reverseAdjacency.get(current) || new Set();
      for (const parentId of currentParents) {
        if (!ancestors.has(parentId)) {
          ancestors.add(parentId);
          queue.push(parentId);
        }
      }
    }

    return ancestors;
  }

  /**
   * Get all descendant IDs (transitive) using BFS
   */
  getDescendants(criterionId: string): Set<string> {
    if (!this.registry.has(criterionId)) {
      return new Set();
    }

    const descendants = new Set<string>();
    const queue: string[] = [];

    // Start with immediate children
    const children = this.adjacencyList.get(criterionId) || new Set();
    for (const childId of children) {
      queue.push(childId);
      descendants.add(childId);
    }

    // BFS to get all transitive descendants
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentChildren = this.adjacencyList.get(current) || new Set();
      for (const childId of currentChildren) {
        if (!descendants.has(childId)) {
          descendants.add(childId);
          queue.push(childId);
        }
      }
    }

    return descendants;
  }

  /**
   * Topological sort using Kahn's algorithm
   * Returns criteria IDs in evaluation order (parents before children)
   */
  topologicalSort(): string[] {
    const result: string[] = [];
    const inDegree = new Map<string, number>();

    // Calculate in-degree for each node
    for (const criterionId of this.registry.keys()) {
      inDegree.set(criterionId, this.reverseAdjacency.get(criterionId)!.size);
    }

    // Queue for nodes with no incoming edges
    const queue: string[] = [];
    for (const [criterionId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(criterionId);
      }
    }

    // Process nodes
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      // Reduce in-degree of children
      const children = this.adjacencyList.get(current) || new Set();
      for (const childId of children) {
        const newDegree = inDegree.get(childId)! - 1;
        inDegree.set(childId, newDegree);
        if (newDegree === 0) {
          queue.push(childId);
        }
      }
    }

    // If result doesn't include all nodes, there's a cycle (shouldn't happen after validation)
    if (result.length !== this.registry.size) {
      throw new Error('Topological sort failed - cycle detected');
    }

    return result;
  }

  /**
   * Filter to root-cause failures (failures with no failing ancestors)
   *
   * If a parent criterion fails, we don't also report the child as failed
   * since the child failure is a consequence of the parent failure.
   */
  getRootFailures(results: CriterionResult[]): CriterionResult[] {
    const failedIds = new Set<string>();
    for (const result of results) {
      if (!result.passed) {
        failedIds.add(result.criterionId);
      }
    }

    const rootFailures: CriterionResult[] = [];
    for (const result of results) {
      if (!result.passed) {
        const ancestors = this.getAncestors(result.criterionId);
        const hasFailedAncestor = Array.from(ancestors).some(ancestorId =>
          failedIds.has(ancestorId)
        );
        if (!hasFailedAncestor) {
          rootFailures.push(result);
        }
      }
    }

    return rootFailures;
  }

  /**
   * Get all criteria in the graph
   */
  getAllCriteria(): CriteriaConfig[] {
    return Array.from(this.registry.values());
  }

  /**
   * Get a single criterion by ID
   */
  getCriterion(id: string): CriteriaConfig | undefined {
    return this.registry.get(id);
  }
}

/**
 * Normalize criteria from v1 format (string prompts) or v2 format (CriteriaConfig[])
 *
 * v1: Converts string array to CriteriaConfig[] with auto-generated IDs
 * v2: Returns as-is if already CriteriaConfig[]
 */
export function normalizeCriteria(
  criteria: string[] | CriteriaConfig[]
): CriteriaConfig[] {
  if (criteria.length === 0) {
    return [];
  }

  // Check if already normalized (CriteriaConfig[])
  if (typeof criteria[0] === 'object' && 'id' in criteria[0]) {
    return criteria as CriteriaConfig[];
  }

  // v1 format: convert strings to CriteriaConfig with auto IDs
  return (criteria as string[]).map((prompt, index) => ({
    id: `criterion-${index + 1}`,
    prompt: prompt.trim(),
    dependsOn: []
  }));
}
