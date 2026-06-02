// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { TaskPromptDocument, PromptFeatureResult, TaskPromptType } from '../types/types.js';
import { computeTaskPromptId } from './task-prompt-id.js';
import type { BlobStorage } from '../storage/blob-storage.js';

/** Default inline-vs-blob threshold (UTF-8 bytes). Bodies larger than this are
 *  stored in blob storage; smaller bodies stay inline in Mongo. */
export const DEFAULT_PROMPT_INLINE_MAX_BYTES = 16 * 1024;

/** Hard guard cap on prompt body size (UTF-8 bytes). Bodies larger than this
 *  are rejected outright, regardless of storage location. */
export const PROMPT_MAX_BYTES = 256 * 1024;

/** Deterministic blob path for a prompt body that lives in blob storage. */
export function promptBlobName(id: string): string {
  return `prompts/${id}.txt`;
}

/**
 * MongoDB-backed store for task prompt entities.
 *
 * Task prompts are **immutable and content-addressed**: the `_id` is a UUIDv5
 * derived from the trimmed prompt text (and, for non-`task` types, the type).
 * The same text+type always resolves to the same document — `findOrCreate` is
 * idempotent.
 *
 * The body is stored **inline** (`text`) when small, or in **blob storage**
 * (`contentBlobUrl`) when it exceeds the configured inline threshold. Storage
 * location is decided purely by size, independent of the prompt `type`.
 *
 * Documents are soft-deleted (deletedAt) rather than removed.
 */
export class TaskPromptStore {
  private readonly inlineMaxBytes: number;

  constructor(
    private collection: Collection<TaskPromptDocument>,
    private blobStorage?: BlobStorage,
    inlineMaxBytes?: number,
  ) {
    this.inlineMaxBytes =
      inlineMaxBytes ??
      (process.env.PROMPT_INLINE_MAX_BYTES
        ? parseInt(process.env.PROMPT_INLINE_MAX_BYTES, 10)
        : DEFAULT_PROMPT_INLINE_MAX_BYTES);
  }

  /** Get a single task prompt by ID (non-deleted) */
  async get(id: string): Promise<TaskPromptDocument | null> {
    return this.collection.findOne({ _id: id, deletedAt: { $exists: false } });
  }

  /** Get a task prompt by its text content (and type) (non-deleted) */
  async getByText(text: string, type?: TaskPromptType): Promise<TaskPromptDocument | null> {
    return this.get(computeTaskPromptId(text, type));
  }

  /**
   * Resolve a prompt document's body to plain text, regardless of storage
   * location: returns inline `text` when present, otherwise downloads the body
   * from blob storage. Throws if the document has neither (corrupt) or if blob
   * storage is needed but not configured.
   */
  async resolvePromptText(doc: TaskPromptDocument): Promise<string> {
    if (doc.text != null) return doc.text;
    if (doc.contentBlobUrl) {
      if (!this.blobStorage) {
        throw new Error(
          `Task prompt '${doc._id}' body is in blob storage but no BlobStorage is configured`,
        );
      }
      const buf = await this.blobStorage.downloadBlobToBuffer(promptBlobName(doc._id));
      return buf.toString('utf-8');
    }
    throw new Error(`Task prompt '${doc._id}' has neither inline text nor a blob reference`);
  }

  /**
   * Find an existing task prompt by text (and type), or create a new one.
   * Idempotent — same text+type always returns the same document.
   *
   * Bodies over the inline threshold are uploaded to blob storage on a create
   * **miss** (and the doc stores only a `contentBlobUrl`); smaller bodies are
   * stored inline. The dedup/lookup is by content hash and never touches blob.
   */
  async findOrCreate(
    text: string,
    opts?: { type?: TaskPromptType },
  ): Promise<TaskPromptDocument> {
    const trimmed = text.trim();
    const type = opts?.type;
    const id = computeTaskPromptId(trimmed, type);

    // Try to find existing (including soft-deleted — revive if needed)
    const existing = await this.collection.findOne({ _id: id });
    if (existing) {
      // If soft-deleted, revive it
      if (existing.deletedAt) {
        await this.collection.updateOne(
          { _id: id },
          { $unset: { deletedAt: '' } }
        );
        return { ...existing, deletedAt: undefined };
      }
      return existing;
    }

    // Enforce the hard size cap before storing anywhere.
    const byteLength = Buffer.byteLength(trimmed, 'utf-8');
    if (byteLength > PROMPT_MAX_BYTES) {
      throw new Error(
        `Prompt body is ${byteLength} bytes, exceeding the maximum of ${PROMPT_MAX_BYTES} bytes`,
      );
    }

    const doc: TaskPromptDocument = {
      _id: id,
      createdAt: new Date(),
    };
    if (type) doc.type = type;

    // Size-based storage: large bodies go to blob, small bodies stay inline.
    if (byteLength > this.inlineMaxBytes) {
      if (!this.blobStorage) {
        throw new Error(
          `Prompt body is ${byteLength} bytes (over the ${this.inlineMaxBytes}-byte inline ` +
            `threshold) but no BlobStorage is configured to store it`,
        );
      }
      doc.contentBlobUrl = await this.blobStorage.uploadText(
        promptBlobName(id),
        trimmed,
      );
    } else {
      doc.text = trimmed;
    }

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /**
   * List active (non-deleted) task prompts.
   * Supports pagination, optional substring search on text, and type scoping.
   *
   * `type` defaults to `task`: when omitted or `'task'`, both explicitly-typed
   * task prompts and legacy docs without a `type` field are returned (so absent
   * type behaves as `task`). Pass `'agents.md'` to list AGENTS.md prompts.
   */
  async getAll(opts?: {
    limit?: number;
    offset?: number;
    search?: string;
    type?: TaskPromptType;
  }): Promise<{ items: TaskPromptDocument[]; total: number }> {
    const filter: Record<string, unknown> = { deletedAt: { $exists: false } };

    if (!opts?.type || opts.type === 'task') {
      filter.$or = [{ type: 'task' }, { type: { $exists: false } }];
    } else {
      filter.type = opts.type;
    }

    if (opts?.search) {
      filter.text = { $regex: opts.search, $options: 'i' };
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
