// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, readdirSync, existsSync, watch, FSWatcher } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { CriteriaConfig } from './types.js';

/**
 * Registry for loading and managing criteria definitions from YAML files
 *
 * Criteria definition file format (config/criteria/*.yaml):
 * ```yaml
 * id: criterion-id
 * prompt: |
 *   Evaluation prompt for the judge agent
 * depends_on:  # or dependsOn
 *   - parent-criterion-1
 *   - parent-criterion-2
 * ```
 */
export class CriteriaRegistry {
  private registry: Map<string, CriteriaConfig>;
  private criteriaDir: string | null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(criteriaDir: string) {
    this.registry = new Map();
    this.criteriaDir = criteriaDir;

    if (!existsSync(criteriaDir)) {
      console.warn(`Criteria directory does not exist: ${criteriaDir}`);
      return;
    }

    this.loadAllCriteria(criteriaDir);
  }

  /**
   * Load all criteria YAML files from the directory
   */
  private loadAllCriteria(criteriaDir: string): void {
    const files = readdirSync(criteriaDir).filter(f =>
      f.endsWith('.yaml') || f.endsWith('.yml')
    );

    for (const file of files) {
      try {
        const filePath = join(criteriaDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const data = parseYaml(content);

        if (!data || typeof data !== 'object') {
          throw new Error(`Invalid YAML content in ${file}`);
        }

        if (!data.id || typeof data.id !== 'string') {
          throw new Error(`Missing or invalid 'id' field in ${file}`);
        }

        if (!data.prompt || typeof data.prompt !== 'string') {
          throw new Error(`Missing or invalid 'prompt' field in ${file}`);
        }

        // Support both depends_on (snake_case) and dependsOn (camelCase)
        const dependsOn = data.depends_on || data.dependsOn || [];
        if (!Array.isArray(dependsOn)) {
          throw new Error(`'depends_on'/'dependsOn' must be an array in ${file}`);
        }

        const criteria: CriteriaConfig = {
          id: data.id.trim(),
          prompt: data.prompt.trim(),
          dependsOn: dependsOn.map((d: any) => String(d).trim())
        };

        // Check for duplicates
        if (this.registry.has(criteria.id)) {
          throw new Error(
            `Duplicate criteria id '${criteria.id}' found in ${file}`
          );
        }

        this.registry.set(criteria.id, criteria);
      } catch (error) {
        throw new Error(
          `Failed to load criteria from ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    console.log(`Loaded ${this.registry.size} criteria definitions from ${criteriaDir}`);
  }

  /**
   * Get a single criterion by ID
   */
  get(id: string): CriteriaConfig | undefined {
    return this.registry.get(id);
  }

  /**
   * Get all criteria
   */
  getAll(): CriteriaConfig[] {
    return Array.from(this.registry.values());
  }

  /**
   * Resolve criteria IDs to CriteriaConfig objects
   * Throws an error if any ID is not found in the registry
   */
  resolve(ids: string[]): CriteriaConfig[] {
    const resolved: CriteriaConfig[] = [];
    for (const id of ids) {
      const criteria = this.registry.get(id);
      if (!criteria) {
        const availableIds = Array.from(this.registry.keys()).join(', ');
        throw new Error(
          `Criteria '${id}' not found in registry. Available criteria: ${availableIds || 'none'}`
        );
      }
      resolved.push(criteria);
    }
    return resolved;
  }

  /**
   * Resolve criteria IDs to CriteriaConfig objects, including all transitive ancestors.
   * This ensures the full DAG is available for CriteriaGraph construction.
   * Throws an error if any ID (leaf or ancestor) is not found in the registry.
   */
  resolveWithAncestors(ids: string[]): CriteriaConfig[] {
    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const criteria = this.registry.get(id);
      if (!criteria) {
        const availableIds = Array.from(this.registry.keys()).join(', ');
        throw new Error(
          `Criteria '${id}' not found in registry. Available criteria: ${availableIds || 'none'}`
        );
      }
      collected.set(id, criteria);

      // Enqueue ancestors
      if (criteria.dependsOn) {
        for (const parentId of criteria.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  /**
   * Check if a criterion exists
   */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /**
   * Get number of loaded criteria
   */
  size(): number {
    return this.registry.size;
  }

  /**
   * Start watching the criteria directory for changes.
   * On detected changes (debounced 500ms), reloads all criteria and logs a diff.
   */
  watch(): void {
    if (!this.criteriaDir || !existsSync(this.criteriaDir)) {
      console.warn('[CriteriaRegistry] Cannot watch — criteria directory not available');
      return;
    }
    if (this.watcher) {
      console.warn('[CriteriaRegistry] Already watching');
      return;
    }

    console.log(`[CriteriaRegistry] Watching for changes in ${this.criteriaDir}`);

    this.watcher = watch(this.criteriaDir, (_eventType, _filename) => {
      // Debounce: multiple rapid events (e.g. syncer writing several files) are coalesced
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.reload();
      }, 500);
    });

    this.watcher.on('error', (err) => {
      console.error('[CriteriaRegistry] Watcher error:', err);
    });
  }

  /**
   * Stop watching the criteria directory.
   */
  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[CriteriaRegistry] Stopped watching');
    }
  }

  /**
   * Reload all criteria from disk and log a diff of changes.
   */
  private reload(): void {
    if (!this.criteriaDir || !existsSync(this.criteriaDir)) return;

    const previousIds = new Set(this.registry.keys());
    const newRegistry = new Map<string, CriteriaConfig>();

    try {
      const files = readdirSync(this.criteriaDir).filter(f =>
        f.endsWith('.yaml') || f.endsWith('.yml')
      );

      for (const file of files) {
        try {
          const filePath = join(this.criteriaDir, file);
          const content = readFileSync(filePath, 'utf-8');
          const data = parseYaml(content);
          if (!data || typeof data !== 'object' || !data.id || !data.prompt) continue;

          const dependsOn = data.depends_on || data.dependsOn || [];
          const criteria: CriteriaConfig = {
            id: data.id.trim(),
            prompt: data.prompt.trim(),
            dependsOn: Array.isArray(dependsOn) ? dependsOn.map((d: any) => String(d).trim()) : [],
          };
          newRegistry.set(criteria.id, criteria);
        } catch {
          // Skip individual file errors during reload (don't crash the judge)
        }
      }

      // Compute diff
      const newIds = new Set(newRegistry.keys());
      const added = [...newIds].filter(id => !previousIds.has(id));
      const removed = [...previousIds].filter(id => !newIds.has(id));
      const unchanged = [...newIds].filter(id => previousIds.has(id));

      this.registry = newRegistry;

      console.log(
        `[CriteriaRegistry] Reloaded: ${newRegistry.size} criteria ` +
        `(+${added.length} added, -${removed.length} removed, ${unchanged.length} unchanged)`
      );
      if (added.length > 0) console.log(`[CriteriaRegistry]   Added: ${added.join(', ')}`);
      if (removed.length > 0) console.log(`[CriteriaRegistry]   Removed: ${removed.join(', ')}`);
    } catch (err) {
      console.error('[CriteriaRegistry] Reload failed:', err);
    }
  }
}

// Singleton instance
let registryInstance: CriteriaRegistry | null = null;

/**
 * Get the singleton CriteriaRegistry instance
 * Creates the instance on first call using CRITERIA_DIR environment variable.
 * If CRITERIA_WATCH=true, automatically starts watching for changes.
 */
export function getCriteriaRegistry(): CriteriaRegistry {
  if (!registryInstance) {
    // Default path is relative to the shared package root
    const defaultPath = join(process.cwd(), 'config', 'criteria');
    const criteriaDir = process.env.CRITERIA_DIR || defaultPath;
    registryInstance = new CriteriaRegistry(criteriaDir);

    if (process.env.CRITERIA_WATCH === 'true') {
      registryInstance.watch();
    }
  }
  return registryInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetCriteriaRegistry(): void {
  registryInstance = null;
}
