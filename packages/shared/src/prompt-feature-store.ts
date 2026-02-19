// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { PromptFeatureConfig, PromptFeatureDocument } from './types.js';
import { DependencyGraph } from './dependency-graph.js';

/**
 * MongoDB-backed prompt feature store for CRUD operations on prompt feature definitions.
 *
 * Mirrors the CriteriaStore pattern — manages prompt features that describe
 * detectable characteristics in task prompts (as opposed to codebases).
 * Documents are soft-deleted (deletedAt) rather than removed.
 */
export class PromptFeatureStore {
  constructor(private collection: Collection<PromptFeatureDocument>) {}

  /** List all active (non-deleted) prompt features */
  async getAll(): Promise<PromptFeatureDocument[]> {
    return this.collection
      .find({ deletedAt: { $exists: false } })
      .sort({ id: 1 })
      .toArray();
  }

  /** Get a single prompt feature by ID */
  async get(id: string): Promise<PromptFeatureDocument | null> {
    return this.collection.findOne({ id, deletedAt: { $exists: false } });
  }

  /** Create a new prompt feature. Validates uniqueness and dependency references. */
  async create(input: {
    id: string;
    prompt: string;
    dependsOn?: string[];
  }): Promise<PromptFeatureDocument> {
    const { id, prompt, dependsOn = [] } = input;

    // Validate ID format
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error(
        `Invalid prompt feature ID '${id}'. Must match [a-z0-9_-]+`
      );
    }

    // Check for duplicates
    const existing = await this.collection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      throw new Error(`Prompt feature '${id}' already exists`);
    }

    // Validate dependency references exist
    if (dependsOn.length > 0) {
      await this.validateDependencies(dependsOn);
    }

    // Validate no cycles would be introduced
    if (dependsOn.length > 0) {
      await this.validateNoCycles(id, dependsOn);
    }

    const doc: PromptFeatureDocument = {
      id,
      prompt: prompt.trim(),
      dependsOn,
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /** Update a prompt feature's prompt and/or dependencies */
  async update(
    id: string,
    patch: { prompt?: string; dependsOn?: string[] }
  ): Promise<PromptFeatureDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Prompt feature '${id}' not found`);
    }

    // Validate dependencies if changing them
    if (patch.dependsOn !== undefined) {
      if (patch.dependsOn.length > 0) {
        await this.validateDependencies(patch.dependsOn);
      }
      await this.validateNoCycles(id, patch.dependsOn);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.prompt !== undefined) update.prompt = patch.prompt.trim();
    if (patch.dependsOn !== undefined) update.dependsOn = patch.dependsOn;

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    return (await this.get(id))!;
  }

  /**
   * Soft-delete a prompt feature.
   * Rejects if other active prompt features depend on this one.
   */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Prompt feature '${id}' not found`);
    }

    // Check for dependents
    const dependents = await this.collection
      .find({
        dependsOn: id,
        deletedAt: { $exists: false },
      })
      .toArray();

    if (dependents.length > 0) {
      const depIds = dependents.map((d) => d.id).join(', ');
      throw new Error(
        `Cannot delete '${id}': other prompt features depend on it: ${depIds}`
      );
    }

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Resolve prompt feature IDs to PromptFeatureConfig objects, including all transitive ancestors.
   */
  async resolveWithAncestors(ids: string[]): Promise<PromptFeatureConfig[]> {
    const collected = new Map<string, PromptFeatureConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const doc = await this.get(id);
      if (!doc) {
        const all = await this.getAll();
        const availableIds = all.map((c) => c.id).join(', ');
        throw new Error(
          `Prompt feature '${id}' not found in store. Available: ${availableIds || 'none'}`
        );
      }

      collected.set(id, { id: doc.id, prompt: doc.prompt, dependsOn: doc.dependsOn });

      if (doc.dependsOn) {
        for (const parentId of doc.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  /**
   * Get the full DAG as nodes + edges for visualization.
   */
  async getGraph(): Promise<{
    nodes: PromptFeatureConfig[];
    edges: { from: string; to: string }[];
  }> {
    const all = await this.getAll();
    const nodes: PromptFeatureConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn,
    }));

    const edges: { from: string; to: string }[] = [];
    for (const feature of all) {
      if (feature.dependsOn) {
        for (const parentId of feature.dependsOn) {
          edges.push({ from: parentId, to: feature.id });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Seed prompt features from configs (upsert — skip existing).
   * Returns the number of newly inserted prompt features.
   */
  async seed(configs: PromptFeatureConfig[]): Promise<number> {
    let inserted = 0;
    for (const config of configs) {
      const existing = await this.collection.findOne({ id: config.id });
      if (!existing) {
        await this.collection.insertOne({
          id: config.id,
          prompt: config.prompt,
          dependsOn: config.dependsOn || [],
          createdAt: new Date(),
        } as any);
        inserted++;
      }
    }
    return inserted;
  }

  // --- Private helpers ---

  /** Validate that all referenced dependency IDs exist in the store */
  private async validateDependencies(dependsOn: string[]): Promise<void> {
    for (const depId of dependsOn) {
      const dep = await this.get(depId);
      if (!dep) {
        throw new Error(`Dependency '${depId}' does not exist`);
      }
    }
  }

  /** Validate that adding edges would not introduce a cycle */
  private async validateNoCycles(
    featureId: string,
    dependsOn: string[]
  ): Promise<void> {
    // Build a temporary in-memory graph with the proposed change
    const all = await this.getAll();
    const configs: PromptFeatureConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.id === featureId ? dependsOn : c.dependsOn,
    }));

    // If this is a new feature, add it
    if (!configs.some((c) => c.id === featureId)) {
      configs.push({ id: featureId, prompt: '(pending)', dependsOn });
    }

    try {
      new DependencyGraph(configs);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ycle')) {
        throw new Error(
          `Adding dependencies [${dependsOn.join(', ')}] to '${featureId}' would create a cycle`
        );
      }
      throw error;
    }
  }
}
