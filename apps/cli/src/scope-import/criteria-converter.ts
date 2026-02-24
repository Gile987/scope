// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  ScopeCriterion,
  ScopeLevel,
  ScopeMtCriterion,
} from './types.js';
import type { LevelDelta } from './level-diff.js';
import { extractAllDeltas } from './level-diff.js';
import { parseChecklist, hasChecklistFormat } from './checklist-parser.js';
import type { ChecklistItem } from './checklist-parser.js';

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
 * @deprecated Use intrinsic IDs (slugify(itemTitle)) instead for new code.
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
 * Build a boolean SCOPE-MT criterion prompt from a parsed checklist item.
 * The prompt is self-contained and intrinsic (no scenario context).
 */
export function buildChecklistPrompt(item: ChecklistItem): string {
  let prompt = `Evaluate whether the solution: ${item.title}\n`;
  if (item.passes) {
    prompt += `\nPASSES when: ${item.passes}`;
  }
  if (item.fails) {
    prompt += `\nFAILS when: ${item.fails}`;
  }
  return prompt;
}

/**
 * Convert a single SCOPE checklist item into a SCOPE-MT criterion
 * with an intrinsic ID (derived from the item title, not the scenario).
 */
export function convertChecklistItem(
  item: ChecklistItem,
  dependsOn?: string[]
): ScopeMtCriterion {
  const id = slugify(item.title);
  const prompt = buildChecklistPrompt(item);

  const result: ScopeMtCriterion = { id, prompt };
  if (dependsOn && dependsOn.length > 0) {
    result.depends_on = dependsOn;
  }
  return result;
}

/**
 * Decompose a SCOPE criterion into individual boolean SCOPE-MT criteria.
 *
 * If the criterion has a parseable checklist format, each checklist item
 * becomes a separate boolean criterion with an intrinsic ID.
 *
 * If the criterion uses a procedural format (no checklist), the entire
 * instructions field is emitted as a single criterion (fallback).
 */
export function decomposeScopeCriterion(
  criterion: ScopeCriterion,
  dependsOn?: string[]
): ScopeMtCriterion[] {
  const items = parseChecklist(criterion.instructions);

  if (items.length > 0) {
    // Checklist format: one criterion per item
    return items.map((item) => convertChecklistItem(item, dependsOn));
  }

  // Fallback: procedural format — emit entire instructions as one criterion
  const simplifiedName = criterion.name
    .replace(/^(Propensity|Efficacy)\s*[-–—]?\s*/i, '')
    .replace(/^[^:]*:\s*/, '')
    .trim();

  const id = slugify(simplifiedName);
  const result: ScopeMtCriterion = {
    id,
    prompt: criterion.instructions.trim(),
  };
  if (dependsOn && dependsOn.length > 0) {
    result.depends_on = dependsOn;
  }
  return [result];
}

/**
 * Convert a SCOPE criterion from a criteria-*.json file into a SCOPE-MT criterion.
 * @deprecated Use decomposeScopeCriterion() for new code — it extracts
 * individual boolean criteria from checklist items.
 */
export function convertScopeCriterion(
  criterion: ScopeCriterion,
  scenarioSlug: string,
  dependsOn?: string[]
): ScopeMtCriterion {
  const simplifiedName = criterion.name
    .replace(/^(Propensity|Efficacy)\s*[-–—]?\s*/i, '')
    .replace(/^[^:]*:\s*/, '')
    .trim();

  const criterionSlug = slugify(simplifiedName);
  const id = namespacedId(scenarioSlug, criterionSlug);

  const weight = importanceLabel(criterion.importance);
  const typeLabel = criterion.metadata.type;
  const levelLabel = criterion.metadata.level
    ? ` (${criterion.metadata.level})`
    : '';

  const prompt = `[${typeLabel}${levelLabel}, ${weight}]\n\n${criterion.instructions.trim()}`;

  const result: ScopeMtCriterion = { id, prompt };
  if (dependsOn && dependsOn.length > 0) {
    result.depends_on = dependsOn;
  }
  return result;
}

/**
 * Decompose all SCOPE criteria from criteria-*.json files for a scenario
 * into individual boolean SCOPE-MT criteria with intrinsic IDs.
 *
 * Each checklist item becomes its own criterion. Criteria without checklist
 * format are emitted as-is (fallback).
 *
 * No dependency chaining between propensity/efficacy groups — that's a
 * scenario-level concern in SCOPE-MT.
 */
export function decomposeAllScopeCriteria(
  criteria: ScopeCriterion[]
): ScopeMtCriterion[] {
  const results: ScopeMtCriterion[] = [];
  for (const c of criteria) {
    results.push(...decomposeScopeCriterion(c));
  }
  return results;
}

/**
 * Convert all SCOPE criteria from criteria-*.json files for a given scenario.
 * @deprecated Use decomposeAllScopeCriteria() for new code.
 */
export function convertAllScopeCriteria(
  criteria: ScopeCriterion[],
  scenarioSlug: string
): ScopeMtCriterion[] {
  const results: ScopeMtCriterion[] = [];

  const propensity = criteria.filter((c) => c.metadata.type === 'Propensity');
  const efficacyL4 = criteria.filter(
    (c) => c.metadata.type === 'Efficacy' && c.metadata.level === 'L4'
  );
  const efficacyL5 = criteria.filter(
    (c) => c.metadata.type === 'Efficacy' && c.metadata.level === 'L5'
  );
  const efficacyOther = criteria.filter(
    (c) =>
      c.metadata.type === 'Efficacy' &&
      c.metadata.level !== 'L4' &&
      c.metadata.level !== 'L5'
  );

  for (const c of propensity) {
    results.push(convertScopeCriterion(c, scenarioSlug));
  }

  const l4Ids: string[] = [];
  for (const c of efficacyL4) {
    const converted = convertScopeCriterion(c, scenarioSlug);
    l4Ids.push(converted.id);
    results.push(converted);
  }

  for (const c of efficacyL5) {
    results.push(
      convertScopeCriterion(c, scenarioSlug, l4Ids.length > 0 ? l4Ids : undefined)
    );
  }

  for (const c of efficacyOther) {
    results.push(convertScopeCriterion(c, scenarioSlug));
  }

  return results;
}

/**
 * Convert level deltas into SCOPE-MT criteria.
 * @deprecated Level deltas are redundant in SCOPE-MT's multi-turn feedback model.
 * Kept for backward compatibility.
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
