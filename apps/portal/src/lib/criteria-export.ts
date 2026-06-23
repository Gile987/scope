// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CriteriaConfig } from "@/types";
import { stringify as yamlStringify } from "yaml";

/**
 * Convert a single criterion to a YAML document string.
 *
 * Uses the `yaml` library's serializer (not string interpolation) so values
 * containing YAML-special characters are quoted/escaped safely and the output
 * round-trips through the importer. Matches the CLI `criteria export` output.
 */
function criterionToYaml(c: CriteriaConfig): string {
  const doc: Record<string, unknown> = {
    id: c.id,
    prompt: c.prompt,
  };
  if (c.dependsOn && c.dependsOn.length > 0) {
    doc.depends_on = c.dependsOn;
  }
  return yamlStringify(doc, { lineWidth: 0 }).trimEnd();
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
