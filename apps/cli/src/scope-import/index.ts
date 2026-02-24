// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { readBenchmarkIndex, deduplicateByScenario, parseBenchmarkDir, listBenchmarkDirs, stripYamlPreamble } from './parser.js';
export { extractDelta, extractAllDeltas, normalizeWhitespace, findOriginalSuffix } from './level-diff.js';
export type { LevelDelta } from './level-diff.js';
export { slugify, namespacedId, convertScopeCriterion, convertAllScopeCriteria, convertLevelDeltas, decomposeScopeCriterion, decomposeAllScopeCriteria, convertChecklistItem, buildChecklistPrompt } from './criteria-converter.js';
export { parseChecklist, hasChecklistFormat } from './checklist-parser.js';
export type { ChecklistItem } from './checklist-parser.js';
export { cosineSimilarity, getEmbeddings, clusterByEmbedding, generateDedupReport, loadCache, saveCache } from './embedding-cluster.js';
export type { ClusterInput, Cluster, ClusterMember } from './embedding-cluster.js';
export { runDedup, collectClusterInputs, buildScenarioCriteriaMap } from './dedup.js';
export type { DedupCriterion, DedupResult } from './dedup.js';
export { scenarioSlug, generateImport } from './scenario-generator.js';
export type {
  ScopeLevel,
  ScopeScenario,
  ScopeCriterion,
  ScopeBenchmark,
  ScopeBenchmarkIndex,
  ParsedBenchmark,
  ScopeMtCriterion,
  ScopeMtScenario,
  ImportResult,
} from './types.js';
