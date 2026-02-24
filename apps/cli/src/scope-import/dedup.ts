// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Deduplication orchestration for SCOPE → SCOPE-MT criterion import.
 *
 * Collects all decomposed checklist items across benchmarks, runs
 * embedding-based clustering, and produces a merged criteria set
 * where semantically-identical items share one canonical criterion ID.
 */

import type { ScopeMtCriterion, ParsedBenchmark, ImportResult } from './types.js';
import type { ChecklistItem } from './checklist-parser.js';
import { parseChecklist } from './checklist-parser.js';
import { slugify, buildChecklistPrompt } from './criteria-converter.js';
import { scenarioSlug } from './scenario-generator.js';
import type { ClusterInput, Cluster } from './embedding-cluster.js';
import {
  getEmbeddings,
  clusterByEmbedding,
  generateDedupReport,
} from './embedding-cluster.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A deduplicated criterion with provenance tracking. */
export interface DedupCriterion {
  /** The canonical criterion (intrinsic ID, merged prompt) */
  criterion: ScopeMtCriterion;
  /** Source scenarios that contributed to this criterion */
  sourceScenarios: string[];
  /** Original titles from the source items (for traceability) */
  sourceTitles: string[];
  /** Number of source items merged into this criterion */
  mergedCount: number;
}

/** Result of the deduplication pipeline. */
export interface DedupResult {
  /** Deduplicated criteria, keyed by canonical ID */
  criteria: Map<string, DedupCriterion>;
  /** Clusters produced by embedding analysis */
  clusters: Cluster[];
  /** Markdown report of the dedup analysis */
  report: string;
  /** Stats */
  stats: {
    totalItems: number;
    uniqueCriteria: number;
    mergedItems: number;
    clusterCount: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the embed text from a checklist item.
 * Uses title + passes + fails for richer semantic signal.
 */
function buildEmbedText(item: ChecklistItem): string {
  let text = item.title;
  if (item.passes) text += `\n${item.passes}`;
  if (item.fails) text += `\n${item.fails}`;
  return text;
}

/**
 * Collect all checklist items from multiple parsed benchmarks as ClusterInputs.
 */
export function collectClusterInputs(
  parsedBenchmarks: ParsedBenchmark[]
): ClusterInput[] {
  const inputs: ClusterInput[] = [];

  for (const parsed of parsedBenchmarks) {
    const slug = scenarioSlug(parsed.scenario.name);

    for (const criterion of parsed.criteria) {
      const items = parseChecklist(criterion.instructions);

      for (const item of items) {
        const key = `${slug}::${slugify(criterion.name)}::${slugify(item.title)}`;
        inputs.push({
          key,
          scenarioSlug: slug,
          criterionName: criterion.name,
          item,
        });
      }
    }
  }

  return inputs;
}

/**
 * Build a canonical criterion from a cluster of similar items.
 *
 * For single-member clusters → use item as-is.
 * For multi-member clusters → pick the representative, note provenance.
 */
function buildCanonicalCriterion(cluster: Cluster): DedupCriterion {
  // Use the representative member (closest to centroid)
  const representative = cluster.members.reduce((best, m) =>
    m.similarityToCentroid > best.similarityToCentroid ? m : best
  );

  const item = representative.input.item;
  const id = slugify(item.title);
  const prompt = buildChecklistPrompt(item);

  const sourceScenarios = [
    ...new Set(cluster.members.map((m) => m.input.scenarioSlug)),
  ];
  const sourceTitles = [
    ...new Set(cluster.members.map((m) => m.input.item.title)),
  ];

  return {
    criterion: { id, prompt },
    sourceScenarios,
    sourceTitles,
    mergedCount: cluster.members.length,
  };
}

/**
 * Handle ID collisions: when two different clusters produce the same slug,
 * disambiguate by appending a numeric suffix.
 */
function disambiguateIds(criteria: Map<string, DedupCriterion>): Map<string, DedupCriterion> {
  const result = new Map<string, DedupCriterion>();
  const idCounts = new Map<string, number>();

  for (const [, dedup] of criteria) {
    const baseId = dedup.criterion.id;
    const count = idCounts.get(baseId) ?? 0;

    if (count === 0 && !result.has(baseId)) {
      // First occurrence — use as-is
      result.set(baseId, dedup);
      idCounts.set(baseId, 1);
    } else {
      // Collision — disambiguate
      const newCount = count + 1;
      idCounts.set(baseId, newCount);

      // If the first one was already placed without suffix, rename it too
      if (count === 1 && result.has(baseId)) {
        const first = result.get(baseId)!;
        result.delete(baseId);
        first.criterion.id = `${baseId}_1`;
        result.set(first.criterion.id, first);
      }

      dedup.criterion.id = `${baseId}_${newCount}`;
      result.set(dedup.criterion.id, dedup);
    }
  }

  return result;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Run the full deduplication pipeline:
 * 1. Collect all checklist items across benchmarks
 * 2. Compute embeddings (with cache)
 * 3. Cluster by similarity
 * 4. Build canonical criteria from clusters
 * 5. Disambiguate ID collisions
 * 6. Generate report
 */
export async function runDedup(
  parsedBenchmarks: ParsedBenchmark[],
  options: {
    cachePath: string;
    clearCache?: boolean;
    threshold?: number;
    token?: string;
    onProgress?: (done: number, total: number) => void;
  }
): Promise<DedupResult> {
  // 1. Collect all checklist items
  const inputs = collectClusterInputs(parsedBenchmarks);

  if (inputs.length === 0) {
    return {
      criteria: new Map(),
      clusters: [],
      report: '# Dedup Report\n\nNo checklist items found.\n',
      stats: {
        totalItems: 0,
        uniqueCriteria: 0,
        mergedItems: 0,
        clusterCount: 0,
      },
    };
  }

  // 2. Compute embeddings
  const embeddings = await getEmbeddings(inputs, options.cachePath, {
    clearCache: options.clearCache,
    token: options.token,
    onProgress: options.onProgress,
  });

  // 3. Cluster by similarity
  const threshold = options.threshold ?? 0.92;
  const clusters = clusterByEmbedding(inputs, embeddings, threshold);

  // 4. Build canonical criteria from clusters
  let criteria = new Map<string, DedupCriterion>();
  for (const cluster of clusters) {
    const dedup = buildCanonicalCriterion(cluster);
    criteria.set(dedup.criterion.id, dedup);
  }

  // 5. Disambiguate ID collisions
  criteria = disambiguateIds(criteria);

  // 6. Generate report
  const report = generateDedupReport(clusters);

  const mergedItems = [...criteria.values()]
    .filter((d) => d.mergedCount > 1)
    .reduce((sum, d) => sum + d.mergedCount, 0);

  return {
    criteria,
    clusters,
    report,
    stats: {
      totalItems: inputs.length,
      uniqueCriteria: criteria.size,
      mergedItems,
      clusterCount: clusters.length,
    },
  };
}

/**
 * Build a scenario-to-criteria mapping from dedup results.
 *
 * For each scenario, returns the list of canonical criterion IDs
 * that apply to it (i.e., the scenario contributed at least one
 * source item to the cluster).
 */
export function buildScenarioCriteriaMap(
  parsedBenchmarks: ParsedBenchmark[],
  dedupResult: DedupResult
): Map<string, string[]> {
  const scenarioMap = new Map<string, string[]>();

  for (const parsed of parsedBenchmarks) {
    const slug = scenarioSlug(parsed.scenario.name);
    const criteriaIds: string[] = [];

    for (const [id, dedup] of dedupResult.criteria) {
      if (dedup.sourceScenarios.includes(slug)) {
        criteriaIds.push(id);
      }
    }

    scenarioMap.set(slug, criteriaIds);
  }

  return scenarioMap;
}
