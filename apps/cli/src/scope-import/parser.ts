// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { parse as yamlParse } from 'yaml';
import type {
  ScopeBenchmark,
  ScopeBenchmarkIndex,
  ScopeCriterion,
  ScopeScenario,
  ParsedBenchmark,
} from './types.js';

/**
 * Read and parse the benchmarks index.json.
 */
export function readBenchmarkIndex(benchmarksDir: string): ScopeBenchmarkIndex {
  const indexPath = join(benchmarksDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`index.json not found in ${benchmarksDir}`);
  }
  const raw = readFileSync(indexPath, 'utf-8');
  return JSON.parse(raw) as ScopeBenchmarkIndex;
}

/**
 * Group benchmarks by scenarioId and return only the first (oldest) benchmark
 * per unique scenario.
 */
export function deduplicateByScenario(
  index: ScopeBenchmarkIndex
): ScopeBenchmarkIndex {
  const seen = new Map<string, ScopeBenchmark>();
  for (const entry of index) {
    if (!seen.has(entry.scenarioId)) {
      seen.set(entry.scenarioId, entry);
    }
  }
  return Array.from(seen.values());
}

/**
 * Parse a single benchmark directory: reads benchmark.json, scenario.yaml,
 * and all criteria-*.json files.
 */
export function parseBenchmarkDir(benchmarkDir: string): ParsedBenchmark {
  // benchmark.json
  const benchmarkPath = join(benchmarkDir, 'benchmark.json');
  if (!existsSync(benchmarkPath)) {
    throw new Error(`benchmark.json not found in ${benchmarkDir}`);
  }
  const benchmark = JSON.parse(
    readFileSync(benchmarkPath, 'utf-8')
  ) as ScopeBenchmark;

  // scenario.yaml
  const scenarioPath = join(benchmarkDir, 'scenario.yaml');
  if (!existsSync(scenarioPath)) {
    throw new Error(`scenario.yaml not found in ${benchmarkDir}`);
  }
  const scenarioRaw = readFileSync(scenarioPath, 'utf-8');
  // The scenario.yaml may have a header line starting with "> @scope/..."
  // Strip any non-YAML preamble lines
  const yamlContent = stripYamlPreamble(scenarioRaw);
  const scenario = yamlParse(yamlContent) as ScopeScenario;

  // criteria-*.json files
  const criteriaByFile: Record<string, ScopeCriterion[]> = {};
  const allCriteria: ScopeCriterion[] = [];

  const files = readdirSync(benchmarkDir).sort();
  for (const file of files) {
    if (file.startsWith('criteria-') && extname(file) === '.json') {
      const filePath = join(benchmarkDir, file);
      const raw = readFileSync(filePath, 'utf-8');
      const criteria = JSON.parse(raw) as ScopeCriterion[];
      criteriaByFile[file] = criteria;
      allCriteria.push(...criteria);
    }
  }

  return { benchmark, scenario, criteria: allCriteria, criteriaByFile };
}

/**
 * Strip non-YAML preamble lines (e.g. shell command echoes). Removes lines
 * before the first YAML key (a line starting with a word character + colon, or
 * starting with "---").
 */
export function stripYamlPreamble(content: string): string {
  const lines = content.split('\n');
  let startIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines and lines starting with ">" (command echo)
    if (line === '' || line.startsWith('>')) {
      startIdx = i + 1;
      continue;
    }
    // Found actual YAML content
    break;
  }

  return lines.slice(startIdx).join('\n');
}

/**
 * List all benchmark directories in the benchmarks root folder.
 */
export function listBenchmarkDirs(benchmarksDir: string): string[] {
  return readdirSync(benchmarksDir)
    .filter((entry) => {
      const fullPath = join(benchmarksDir, entry);
      return (
        statSync(fullPath).isDirectory() &&
        existsSync(join(fullPath, 'benchmark.json'))
      );
    })
    .sort()
    .map((entry) => join(benchmarksDir, entry));
}
