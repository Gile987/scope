// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { TaskPromptDocument, PromptFeatureResult, PromptType } from '../types/types.js';
import { computePromptId } from './task-prompt-id.js';

/**
 * MongoDB-backed store for task prompt entities.
 *
 * Task prompts are **immutable and content-addressed**: the `_id` is a UUIDv5
 * derived from the trimmed prompt text (and, for non-Select gates, the prompt
 * `type`). The same `(type, text)` always resolves to the same document —
 * `findOrCreate` is idempotent.
 *
 * Prompts carry a `type` discriminator — one literal per gate (the Select gate's
 * prompt is the request's task prompt). `type` defaults to `"select"` so
 * existing task-prompt call sites are unaffected.
 *
 * Documents are soft-deleted (deletedAt) rather than removed.
 */
export class TaskPromptStore {
  constructor(private collection: Collection<TaskPromptDocument>) {}

  /** Get a single task prompt by ID (non-deleted) */
  async get(id: string): Promise<TaskPromptDocument | null> {
    return this.collection.findOne({ _id: id, deletedAt: { $exists: false } });
  }

  /** Get a task prompt by its text content and type (non-deleted) */
  async getByText(text: string, type: PromptType = 'select'): Promise<TaskPromptDocument | null> {
    return this.get(computePromptId(type, text));
  }

  /**
   * Find an existing task prompt by `(type, text)`, or create a new one.
   * Idempotent — the same `(type, text)` always returns the same document.
   * `type` defaults to `"select"` (the request task prompt).
   */
  async findOrCreate(text: string, type: PromptType = 'select'): Promise<TaskPromptDocument> {
    const trimmed = text.trim();
    const id = computePromptId(type, trimmed);

    // Try to find existing (including soft-deleted — revive if needed)
    const existing = await this.collection.findOne({ _id: id });
    if (existing) {
      // Backfill type on legacy documents lacking it, and revive if soft-deleted.
      const patch: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (existing.type === undefined) patch.type = type;
      if (existing.deletedAt) unset.deletedAt = '';
      if (Object.keys(patch).length > 0 || Object.keys(unset).length > 0) {
        await this.collection.updateOne(
          { _id: id },
          {
            ...(Object.keys(patch).length > 0 ? { $set: patch } : {}),
            ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          } as any,
        );
        return { ...existing, ...patch, deletedAt: undefined };
      }
      return existing;
    }

    // Create new document
    const doc: TaskPromptDocument = {
      _id: id,
      type,
      text: trimmed,
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /**
   * List active (non-deleted) task prompts.
   * Supports pagination, optional substring search on text, and an optional
   * `type` filter (one prompt type per gate).
   */
  async getAll(opts?: {
    limit?: number;
    offset?: number;
    search?: string;
    type?: PromptType;
  }): Promise<{ items: TaskPromptDocument[]; total: number }> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

    if (opts?.search) {
      filter.text = { $regex: opts.search, $options: 'i' };
    }
    if (opts?.type) {
      filter.type = opts.type;
    }

    const total = await this.collection.countDocuments(filter);
    const cursor = this.collection
      .find(filter)
      .sort({ createdAt: -1 });

    if (opts?.offset) {
      cursor.skip(opts.offset);
    }
    if (opts?.limit) {
      cursor.limit(opts.limit);
    }

    const items = await cursor.toArray();
    return { items, total };
  }

  /** Soft-delete a task prompt */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Attach prompt feature extraction results to a task prompt.
   * This is the only mutable operation — it enriches the entity
   * without changing its identity (text / _id).
   */
  async attachFeatures(
    id: string,
    features: PromptFeatureResult[]
  ): Promise<TaskPromptDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      {
        $set: {
          features,
          featuresExtractedAt: new Date(),
        },
      }
    );

    return (await this.get(id))!;
  }

  /**
   * Toggle the `detected` flag on a single feature.
   * If the feature doesn't exist in the array, it's added as evaluated+detected.
   */
  async toggleFeature(
    id: string,
    featureId: string,
    detected: boolean
  ): Promise<TaskPromptDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task prompt '${id}' not found`);
    }

    const features = existing.features ? [...existing.features] : [];
    const idx = features.findIndex((f) => f.featureId === featureId);

    if (idx >= 0) {
      features[idx] = { ...features[idx], detected, evaluated: true };
    } else {
      features.push({ featureId, detected, evaluated: true });
    }

    await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { features } }
    );

    return (await this.get(id))!;
  }
}
