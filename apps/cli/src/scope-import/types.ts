// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Types for SCOPE benchmark data structures used during import.
 */

/** A single level within a SCOPE scenario (L0–L5). */
export interface ScopeLevel {
  name: string;
  instruction: string;
  metadata: {
    level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
    type: 'Propensity' | 'Efficacy';
  };
  workspaceSnapshotUrl?: string;
}

/** A SCOPE scenario containing multiple levels. */
export interface ScopeScenario {
  _id: string;
  name: string;
  levels: ScopeLevel[];
  metadata: Record<string, string>;
  owner?: string;
}

/** A single SCOPE criterion from a criteria-*.json file. */
export interface ScopeCriterion {
  name: string;
  importance: 1 | 3 | 5;
  instructions: string;
  metadata: {
    type: 'Propensity' | 'Efficacy';
    level?: string;
  };
}

/** A SCOPE benchmark.json metadata file. */
export interface ScopeBenchmark {
  id: string;
  scenarioId: string;
  scenarioName: string;
  name: string;
  indices?: {
    efficacy?: number;
    propensity?: number;
  };
  owner?: string;
  updatedAt?: string;
}

/** An entry in the SCOPE benchmarks index.json. */
export type ScopeBenchmarkIndex = ScopeBenchmark[];

/** A parsed SCOPE benchmark directory — all data from one benchmark folder. */
export interface ParsedBenchmark {
  benchmark: ScopeBenchmark;
  scenario: ScopeScenario;
  criteria: ScopeCriterion[];
  /** Mapping of criteria filename → criteria array for traceability. */
  criteriaByFile: Record<string, ScopeCriterion[]>;
}

/** SCOPE-MT criterion in YAML format. */
export interface ScopeMtCriterion {
  id: string;
  prompt: string;
  depends_on?: string[];
}

/** SCOPE-MT scenario in v2 YAML format. */
export interface ScopeMtScenario {
  version: 'v2';
  task: string;
  criteria: string[];
}

/** Result of the full import for one SCOPE scenario. */
export interface ImportResult {
  scenarioSlug: string;
  scenarioName: string;
  scenario: ScopeMtScenario;
  criteria: ScopeMtCriterion[];
  /** Level deltas extracted as criteria. */
  levelDeltaCriteria: ScopeMtCriterion[];
  /** SCOPE criteria converted to SCOPE-MT format. */
  scopeCriteria: ScopeMtCriterion[];
}
