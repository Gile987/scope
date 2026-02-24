// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  ScopeMtCriterion,
  ScopeMtScenario,
  ImportResult,
  ParsedBenchmark,
} from './types.js';
import { slugify } from './criteria-converter.js';
import {
  convertAllScopeCriteria,
  convertLevelDeltas,
  decomposeAllScopeCriteria,
} from './criteria-converter.js';

/**
 * Generate a scenario slug from a SCOPE scenario name.
 * e.g. "JavaScript Web Chat Application with Azure AI" → "js_web_chat_app_with_azure_ai"
 *
 * Applies extra shortening: removes common filler words.
 */
export function scenarioSlug(name: string): string {
  // Shorten common words for more readable IDs
  const shortened = name
    .replace(/\bApplication\b/gi, 'app')
    .replace(/\bJavaScript\b/gi, 'js')
    .replace(/\bTypeScript\b/gi, 'ts')
    .replace(/\bPython\b/gi, 'py')
    .replace(/\bServerless\b/gi, 'sls');

  return slugify(shortened);
}

/**
 * Generate SCOPE-MT scenario and criteria from a parsed SCOPE benchmark.
 *
 * In the new model (v2-decomposed), each SCOPE checklist item becomes an
 * individual boolean criterion with an intrinsic ID. Level deltas are no
 * longer included — SCOPE-MT's multi-turn feedback loop handles progressive
 * nudging dynamically.
 */
export function generateImport(parsed: ParsedBenchmark): ImportResult {
  const slug = scenarioSlug(parsed.scenario.name);

  // Find L0 level for the base task prompt
  const l0 = parsed.scenario.levels.find(
    (l) => l.metadata.level === 'L0'
  );
  // If no L0, use the first level
  const baseLevel = l0 || parsed.scenario.levels[0];
  const taskPrompt = baseLevel.instruction.trim();

  // Decompose SCOPE criteria into individual boolean criteria
  // with intrinsic IDs (no scenario prefix)
  const scopeCriteria = decomposeAllScopeCriteria(parsed.criteria);

  // Level deltas are kept for backward-compat but NOT included in the
  // main criteria output — SCOPE-MT feedback loop replaces static nudging
  const levelDeltaCriteria = convertLevelDeltas(
    parsed.scenario.levels,
    slug
  );

  // Build the scenario (v2 format, referencing criteria by intrinsic ID)
  const scenario: ScopeMtScenario = {
    version: 'v2',
    task: taskPrompt,
    criteria: scopeCriteria.map((c) => c.id),
  };

  return {
    scenarioSlug: slug,
    scenarioName: parsed.scenario.name,
    scenario,
    criteria: scopeCriteria,
    levelDeltaCriteria,
    scopeCriteria,
  };
}
