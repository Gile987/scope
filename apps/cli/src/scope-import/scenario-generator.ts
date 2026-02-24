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
 * Takes the L0 instruction as the task prompt, extracts level deltas as
 * criteria, and converts SCOPE criteria JSON files to SCOPE-MT criteria.
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

  // Extract level deltas as criteria
  const levelDeltaCriteria = convertLevelDeltas(
    parsed.scenario.levels,
    slug
  );

  // Convert SCOPE criteria files to SCOPE-MT criteria
  const scopeCriteria = convertAllScopeCriteria(
    parsed.criteria,
    slug
  );

  // Combine all criteria
  const allCriteria = [...levelDeltaCriteria, ...scopeCriteria];

  // Build the scenario (v2 format, referencing criteria by ID)
  const scenario: ScopeMtScenario = {
    version: 'v2',
    task: taskPrompt,
    criteria: allCriteria.map((c) => c.id),
  };

  return {
    scenarioSlug: slug,
    scenarioName: parsed.scenario.name,
    scenario,
    criteria: allCriteria,
    levelDeltaCriteria,
    scopeCriteria,
  };
}
