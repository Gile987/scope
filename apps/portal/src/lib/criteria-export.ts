// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CriteriaConfig } from "@/types";

/**
 * Convert a single criterion to YAML document string.
 * Uses block literal style for multi-line prompts.
 */
function criterionToYaml(c: CriteriaConfig): string {
  const lines: string[] = [`id: ${c.id}`];

  // Use block literal (|) for prompts, inline for single-line
  const promptLines = c.prompt.trimEnd().split("\n");
  if (promptLines.length > 1 || c.prompt.length > 80) {
    lines.push("prompt: |");
    for (const line of promptLines) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push(`prompt: ${c.prompt.trimEnd()}`);
  }

  if (c.dependsOn && c.dependsOn.length > 0) {
    lines.push("depends_on:");
    for (const dep of c.dependsOn) {
      lines.push(`  - ${dep}`);
    }
  }

  return lines.join("\n");
}

/**
 * Topologically sort criteria so parents appear before children.
 */
function topoSort(criteria: CriteriaConfig[]): CriteriaConfig[] {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const sorted: CriteriaConfig[] = [];
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const c = byId.get(id);
    if (!c) return;
    for (const dep of c.dependsOn ?? []) {
      visit(dep);
    }
    sorted.push(c);
  };

  for (const c of criteria) {
    visit(c.id);
  }
  return sorted;
}

/**
 * Resolve a set of criteria IDs and all their dependency ancestors
 * from a full criteria list.
 */
export function resolveWithAncestors(
  ids: string[],
  allCriteria: CriteriaConfig[],
): CriteriaConfig[] {
  const byId = new Map(allCriteria.map((c) => [c.id, c]));
  const included = new Set<string>();

  const resolve = (id: string) => {
    if (included.has(id)) return;
    const criterion = byId.get(id);
    if (!criterion) return;
    included.add(id);
    for (const dep of criterion.dependsOn ?? []) {
      resolve(dep);
    }
  };

  for (const id of ids) {
    resolve(id);
  }

  return allCriteria.filter((c) => included.has(c.id));
}

/**
 * Generate import-compatible multi-document YAML from criteria.
 * Output uses snake_case `depends_on` and `---` separators.
 */
export function criteriaToExportYaml(criteria: CriteriaConfig[]): string {
  const sorted = topoSort(criteria);
  return sorted.map(criterionToYaml).join("\n---\n") + "\n";
}

/**
 * Trigger a browser file download with the given content.
 */
export function downloadAsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
