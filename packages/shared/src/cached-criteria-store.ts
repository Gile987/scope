// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CriteriaConfig } from './types.js';
import { CriteriaStore } from './criteria-store.js';

interface CacheEntry {
  value: CriteriaConfig;
  expiry: number;
}

interface CachedCriteriaStoreOptions {
  maxSize?: number;
  ttlMs?: number;
}

/**
 * LRU-cached wrapper around CriteriaStore for fast per-criterion lookups.
 *
 * Used by the judge to avoid hitting MongoDB for every criterion on every
 * evaluation request. Entries expire after `ttlMs` and the cache is bounded
 * to `maxSize` entries (oldest evicted first).
 */
export class CachedCriteriaStore {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(
    private store: CriteriaStore,
    options: CachedCriteriaStoreOptions = {},
  ) {
    this.maxSize = options.maxSize ?? 200;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /** Get a single criterion by ID, with LRU caching. */
  async get(id: string): Promise<CriteriaConfig | null> {
    const now = Date.now();
    const cached = this.cache.get(id);

    if (cached && cached.expiry > now) {
      // Move to end (most-recently-used) by re-inserting
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached.value;
    }

    // Cache miss or expired — fetch from store
    if (cached) this.cache.delete(id); // remove expired

    const doc = await this.store.get(id);
    if (!doc) return null;

    const entry: CacheEntry = { value: doc, expiry: now + this.ttlMs };
    this.cache.set(id, entry);
    this.evictIfNeeded();
    return doc;
  }

  /**
   * Resolve criteria IDs to CriteriaConfig[], including all transitive
   * ancestors. Uses per-criterion caching via `this.get()`.
   */
  async resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]> {
    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const doc = await this.get(id);
      if (!doc) {
        const all = await this.store.getAll();
        const availableIds = all.map((c) => c.id).join(', ');
        throw new Error(
          `Criteria '${id}' not found in store. Available: ${availableIds || 'none'}`,
        );
      }

      collected.set(id, doc);
      if (doc.dependsOn) {
        for (const dep of doc.dependsOn) {
          if (!collected.has(dep)) queue.push(dep);
        }
      }
    }

    return Array.from(collected.values());
  }

  /** Delegate to underlying store (not cached — used rarely). */
  async getAll(): Promise<CriteriaConfig[]> {
    return this.store.getAll();
  }

  /** Remove a single entry from the cache. */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  // --- internal ---

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxSize) {
      // Map iteration order is insertion order → first key is the oldest
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
  }
}
