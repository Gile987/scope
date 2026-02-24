// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  ScopeCriterion,
  ScopeLevel,
  ScopeMtCriterion,
} from './types.js';
import type { LevelDelta } from './level-diff.js';
import { extractAllDeltas } from './level-diff.js';

/**
 * Slugify a string for use as a SCOPE-MT criterion ID.
 * Converts to lowercase, replaces non-alnum with underscores, collapses
 * consecutive underscores, strips leading/trailing underscores, and enforces
 * the ^[a-z][a-z0-9_]*$ pattern.
 */
export function slugify(text: string): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // Ensure starts with a letter
  if (slug && !/^[a-z]/.test(slug)) {
    slug = 'c_' + slug;
  }

  return slug;
}

/**
 * Create a scenario-namespaced criterion ID.
 */
export function namespacedId(scenarioSlug: string, criterionSlug: string): string {
  return `${scenarioSlug}_${criterionSlug}`;
}

/**
 * Map SCOPE importance (1, 3, 5) to a human-readable weight label.
 */
function importanceLabel(importance: number): string {
  switch (importance) {
    case 5:
      return 'Critical';
    case 3:
      return 'Important';
    case 1:
      return 'NiceToHave';
    default:
      return `Weight${importance}`;
  }
}

/**
 * Convert a SCOPE criterion from a criteria-*.json file into a SCOPE-MT criterion.
 *
 * The SCOPE `instructions` field (which contains the detailed rubric with
 * pass/fail/skip conditions) becomes the SCOPE-MT `prompt`.
 */
export function convertScopeCriterion(
  criterion: ScopeCriterion,
  scenarioSlug: string,
  dependsOn?: string[]
): ScopeMtCriterion {
  // Simplify the name for the ID: strip "Propensity N:" / "Efficacy - X N:" prefixes
  // Examples:
  //   "Propensity 1: Application uses Azure AI services" → "Application uses Azure AI services"
  //   "Efficacy - Service Selection 1: Correct Service Selection" → "Correct Service Selection"
  const simplifiedName = criterion.name
    .replace(/^(Propensity|Efficacy)\s*[-–—]?\s*/i, '')
    .replace(/^[^:]*:\s*/, '')
    .trim();

  const criterionSlug = slugify(simplifiedName);
  const id = namespacedId(scenarioSlug, criterionSlug);

  // Build prompt from instructions, prepending weight context
  const weight = importanceLabel(criterion.importance);
  const typeLabel = criterion.metadata.type;
  const levelLabel = criterion.metadata.level
    ? ` (${criterion.metadata.level})`
    : '';

  let prompt = `[${typeLabel}${levelLabel}, ${weight}]\n\n${criterion.instructions.trim()}`;

  const result: ScopeMtCriterion = { id, prompt };
  if (dependsOn && dependsOn.length > 0) {
    result.depends_on = dependsOn;
  }
  return result;
}

/**
 * Convert all SCOPE criteria from criteria-*.json files for a given scenario.
 *
 * Criteria are grouped by type (Propensity vs Efficacy) and level.
 * Efficacy L5 criteria depend on efficacy L4 criteria.
 */
export function convertAllScopeCriteria(
  criteria: ScopeCriterion[],
  scenarioSlug: string
): ScopeMtCriterion[] {
  const results: ScopeMtCriterion[] = [];

  // Separate by type
  const propensity = criteria.filter((c) => c.metadata.type === 'Propensity');
  const efficacyL4 = criteria.filter(
    (c) => c.metadata.type === 'Efficacy' && c.metadata.level === 'L4'
  );
  const efficacyL5 = criteria.filter(
    (c) => c.metadata.type === 'Efficacy' && c.metadata.level === 'L5'
  );
  // Efficacy criteria without a specific level
  const efficacyOther = criteria.filter(
    (c) =>
      c.metadata.type === 'Efficacy' &&
      c.metadata.level !== 'L4' &&
      c.metadata.level !== 'L5'
  );

  // Convert propensity — no dependencies
  for (const c of propensity) {
    results.push(convertScopeCriterion(c, scenarioSlug));
  }

  // Convert efficacy L4 — no dependencies
  const l4Ids: string[] = [];
  for (const c of efficacyL4) {
    const converted = convertScopeCriterion(c, scenarioSlug);
    l4Ids.push(converted.id);
    results.push(converted);
  }

  // Convert efficacy L5 — depend on L4 criteria
  for (const c of efficacyL5) {
    results.push(
      convertScopeCriterion(c, scenarioSlug, l4Ids.length > 0 ? l4Ids : undefined)
    );
  }

  // Convert other efficacy criteria
  for (const c of efficacyOther) {
    results.push(convertScopeCriterion(c, scenarioSlug));
  }

  return results;
}

/**
 * Convert level deltas into SCOPE-MT criteria.
 *
 * Each delta (e.g., L0→L1 adds "consider using a cloud provider") becomes
 * a criterion that checks for the presence of that incremental requirement
 * in the agent's output.
 */
export function convertLevelDeltas(
  levels: ScopeLevel[],
  scenarioSlug: string
): ScopeMtCriterion[] {
  const deltas = extractAllDeltas(levels);
  const results: ScopeMtCriterion[] = [];
  let previousId: string | undefined;

  for (const delta of deltas) {
    const levelTag = delta.toLevel.toLowerCase();
    const id = namespacedId(scenarioSlug, `${levelTag}_delta`);

    let prompt: string;
    if (delta.isCumulative) {
      prompt =
        `The agent's output reflects the following additional guidance ` +
        `(added at ${delta.toLevel} over ${delta.fromLevel}):\n\n${delta.addedText}`;
    } else {
      prompt =
        `The agent's output satisfies the ${delta.toLevel} requirements ` +
        `(rewritten from ${delta.fromLevel}):\n\n${delta.addedText}`;
    }

    const criterion: ScopeMtCriterion = { id, prompt };

    // Chain propensity deltas: L2 depends on L1, L3 depends on L2
    if (
      previousId &&
      delta.fromLevel.startsWith('L') &&
      delta.toLevel.startsWith('L') &&
      parseInt(delta.toLevel[1]) <= 3
    ) {
      criterion.depends_on = [previousId];
    }

    results.push(criterion);
    previousId = id;
  }

  return results;
}
