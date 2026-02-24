// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Embedding-based clustering for SCOPE checklist item deduplication.
 *
 * Uses GitHub Models API (text-embedding-3-small) to embed checklist items,
 * computes pairwise cosine similarity, and clusters similar items together.
 *
 * Embeddings are cached to `.embedding-cache.json` to avoid redundant API calls.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { ChecklistItem } from './checklist-parser.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A checklist item with its source context for clustering. */
export interface ClusterInput {
  /** Unique key combining scenario + criterion + item title */
  key: string;
  /** Source scenario slug */
  scenarioSlug: string;
  /** Source SCOPE criterion name */
  criterionName: string;
  /** The parsed checklist item */
  item: ChecklistItem;
}

/** A cached embedding entry. */
interface CacheEntry {
  /** The input text that was embedded */
  text: string;
  /** The embedding vector */
  vector: number[];
  /** ISO timestamp of when the embedding was created */
  createdAt: string;
}

/** The embedding cache file structure. */
interface EmbeddingCache {
  model: string;
  entries: Record<string, CacheEntry>;
}

/** A cluster of similar checklist items. */
export interface Cluster {
  /** Auto-generated cluster ID (index) */
  id: number;
  /** Representative title (from the item closest to centroid) */
  representativeTitle: string;
  /** Members of this cluster */
  members: ClusterMember[];
  /** Average pairwise similarity within the cluster */
  avgSimilarity: number;
}

export interface ClusterMember {
  input: ClusterInput;
  /** Cosine similarity to the cluster centroid */
  similarityToCentroid: number;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Embedding Cache ─────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'text-embedding-3-small';

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function itemToText(item: ChecklistItem): string {
  return `${item.title}\nPASSES when: ${item.passes}\nFAILS when: ${item.fails}`;
}

export function loadCache(cachePath: string): EmbeddingCache {
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, 'utf-8');
      return JSON.parse(raw) as EmbeddingCache;
    } catch {
      // Corrupt cache — start fresh
    }
  }
  return { model: DEFAULT_MODEL, entries: {} };
}

export function saveCache(cachePath: string, cache: EmbeddingCache): void {
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

// ─── Embedding API ───────────────────────────────────────────────────────────

/**
 * Get embeddings for a list of texts, using cache where possible.
 * Only texts not in cache will be sent to the API.
 */
export async function getEmbeddings(
  inputs: ClusterInput[],
  cachePath: string,
  options: {
    clearCache?: boolean;
    token?: string;
    model?: string;
    batchSize?: number;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<Map<string, number[]>> {
  const model = options.model ?? DEFAULT_MODEL;
  const batchSize = options.batchSize ?? 256;

  let cache = options.clearCache
    ? { model, entries: {} as Record<string, CacheEntry> }
    : loadCache(cachePath);

  // If model changed, invalidate cache
  if (cache.model !== model) {
    cache = { model, entries: {} };
  }

  // Build text map and identify cache misses
  const textMap = new Map<string, string>(); // key → text
  const hashMap = new Map<string, string>(); // key → hash
  const misses: { key: string; text: string; hash: string }[] = [];

  for (const input of inputs) {
    const text = itemToText(input.item);
    const hash = contentHash(text);
    textMap.set(input.key, text);
    hashMap.set(input.key, hash);

    if (!cache.entries[hash]) {
      misses.push({ key: input.key, text, hash });
    }
  }

  // Fetch embeddings for cache misses in batches
  if (misses.length > 0) {
    const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_MODELS_API_KEY;
    if (!token) {
      throw new Error(
        'No API token found. Set GITHUB_TOKEN or GITHUB_MODELS_API_KEY environment variable.'
      );
    }

    for (let i = 0; i < misses.length; i += batchSize) {
      const batch = misses.slice(i, i + batchSize);
      const batchTexts = batch.map((m) => m.text);

      const response = await fetch('https://models.inference.ai.azure.com/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          input: batchTexts,
          model,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Embedding API error (${response.status}): ${errorBody}`
        );
      }

      const result = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Store results in cache
      for (const item of result.data) {
        const miss = batch[item.index];
        cache.entries[miss.hash] = {
          text: miss.text,
          vector: item.embedding,
          createdAt: new Date().toISOString(),
        };
      }

      options.onProgress?.(Math.min(i + batchSize, misses.length), misses.length);
    }

    // Save updated cache
    saveCache(cachePath, cache);
  }

  // Build result map
  const result = new Map<string, number[]>();
  for (const input of inputs) {
    const hash = hashMap.get(input.key)!;
    const entry = cache.entries[hash];
    if (entry) {
      result.set(input.key, entry.vector);
    }
  }

  return result;
}

// ─── Clustering ──────────────────────────────────────────────────────────────

/**
 * Compute the centroid (mean vector) of a set of vectors.
 */
function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i];
    }
  }
  return sum.map((s) => s / vectors.length);
}

/**
 * Cluster checklist items by embedding similarity using greedy agglomerative
 * clustering.
 *
 * For each unclustered item, find all other unclustered items with
 * similarity >= threshold. Form a cluster. Continue until no more items
 * can be clustered.
 *
 * Items that don't match any other item (singletons) are returned as
 * single-member clusters.
 */
export function clusterByEmbedding(
  inputs: ClusterInput[],
  embeddings: Map<string, number[]>,
  threshold: number = 0.8
): Cluster[] {
  const n = inputs.length;
  const vectors = inputs.map((inp) => embeddings.get(inp.key)!);

  // Build similarity matrix (upper triangle only)
  const sim = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(vectors[i], vectors[j]);
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }

  // Greedy clustering
  const assigned = new Set<number>();
  const clusters: Cluster[] = [];
  let clusterId = 0;

  // Sort by connectivity (items similar to many others cluster first)
  const connectivity = inputs.map((_, i) => {
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j && sim[i * n + j] >= threshold) count++;
    }
    return { index: i, count };
  });
  connectivity.sort((a, b) => b.count - a.count);

  for (const { index: seedIdx } of connectivity) {
    if (assigned.has(seedIdx)) continue;

    // Find all unassigned items similar to seed
    const memberIndices = [seedIdx];
    for (let j = 0; j < n; j++) {
      if (j !== seedIdx && !assigned.has(j) && sim[seedIdx * n + j] >= threshold) {
        memberIndices.push(j);
      }
    }

    // Mark as assigned
    for (const idx of memberIndices) {
      assigned.add(idx);
    }

    // Compute centroid
    const memberVectors = memberIndices.map((i) => vectors[i]);
    const cent = centroid(memberVectors);

    // Build cluster members with similarity to centroid
    const members: ClusterMember[] = memberIndices.map((i) => ({
      input: inputs[i],
      similarityToCentroid: cosineSimilarity(vectors[i], cent),
    }));

    // Sort by similarity to centroid (most representative first)
    members.sort((a, b) => b.similarityToCentroid - a.similarityToCentroid);

    // Compute average pairwise similarity
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < memberIndices.length; i++) {
      for (let j = i + 1; j < memberIndices.length; j++) {
        pairSum += sim[memberIndices[i] * n + memberIndices[j]];
        pairCount++;
      }
    }

    clusters.push({
      id: clusterId++,
      representativeTitle: members[0].input.item.title,
      members,
      avgSimilarity: pairCount > 0 ? pairSum / pairCount : 1.0,
    });
  }

  // Sort: multi-member clusters first (by size desc), then singletons
  clusters.sort((a, b) => b.members.length - a.members.length);

  return clusters;
}

// ─── Report Generation ───────────────────────────────────────────────────────

/**
 * Generate a markdown dedup report from clustering results.
 */
export function generateDedupReport(clusters: Cluster[]): string {
  const multiMember = clusters.filter((c) => c.members.length > 1);
  const singletons = clusters.filter((c) => c.members.length === 1);

  const lines: string[] = [
    '# SCOPE Criteria Deduplication Report',
    '',
    `Total checklist items: ${clusters.reduce((s, c) => s + c.members.length, 0)}`,
    `Clusters with 2+ members: ${multiMember.length}`,
    `Singleton items: ${singletons.length}`,
    `Potential dedup savings: ${multiMember.reduce((s, c) => s + c.members.length - 1, 0)} items`,
    '',
  ];

  for (const cluster of multiMember) {
    lines.push(`## Cluster ${cluster.id + 1}: "${cluster.representativeTitle}" (avg similarity: ${cluster.avgSimilarity.toFixed(3)})`);
    lines.push('');
    lines.push('| Scenario | Title | Similarity |');
    lines.push('|---|---|---|');
    for (const member of cluster.members) {
      lines.push(
        `| ${member.input.scenarioSlug} | ${member.input.item.title} | ${member.similarityToCentroid.toFixed(3)} |`
      );
    }
    lines.push('');
  }

  if (singletons.length > 0) {
    lines.push('## Unique Items (no duplicates found)');
    lines.push('');
    lines.push('| Scenario | Title |');
    lines.push('|---|---|');
    for (const cluster of singletons) {
      const m = cluster.members[0];
      lines.push(`| ${m.input.scenarioSlug} | ${m.input.item.title} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
