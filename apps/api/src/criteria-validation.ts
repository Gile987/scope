// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DependencyGraph } from "shared";

export type CriteriaGraphNode = { id: string; dependsOn?: string[] };

export function normalizeDependsOn(dependsOn: unknown): string[] {
  if (!Array.isArray(dependsOn)) {
    return [];
  }
  return dependsOn.map((dependency) => String(dependency).trim()).filter(Boolean);
}

export function ensureNoSelfReference(id: string, dependsOn: string[]): void {
  if (dependsOn.includes(id)) {
    throw new Error("A criterion cannot depend on itself");
  }
}

export function ensureDependenciesExist(
  dependsOn: string[],
  availableIds: ReadonlySet<string>,
): void {
  for (const dependencyId of dependsOn) {
    if (!availableIds.has(dependencyId)) {
      throw new Error(`Dependency '${dependencyId}' does not exist`);
    }
  }
}

export function ensureAcyclicCriteria(criteria: CriteriaGraphNode[]): void {
  new DependencyGraph(
    criteria.map((criterion) => ({
      ...criterion,
      dependsOn: criterion.dependsOn ?? [],
    })),
  );
}
