// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { CodebaseDocument, CodebaseSourceType } from "../types/codebase.js";
import { slugifyCodebaseName } from "./codebase-revision-id.js";

/** Input for creating a new codebase entity. */
export interface CreateCodebaseInput {
  name: string;
  slug?: string;
  description?: string;
  sourceType: CodebaseSourceType;
  source?: string;
  defaultBranch?: string;
  creator?: string;
}

/** Mutable fields that can be patched on a codebase. */
export interface UpdateCodebaseInput {
  name?: string;
  description?: string;
  defaultBranch?: string;
}

/**
 * MongoDB-backed store for the mutable `codebases` collection.
 *
 * Owns slug uniqueness, soft delete, the atomic per-codebase revision counter,
 * and the `latestRevisionId` pointer. Revision snapshots live in the immutable
 * `codebase-revisions` collection (see {@link CodebaseRevisionStore}).
 */
export class CodebaseStore {
  constructor(private collection: Collection<CodebaseDocument>) {}

  /** Get a codebase by its UUID `_id` (excludes soft-deleted by default). */
  async get(id: string, opts?: { includeDeleted?: boolean }): Promise<CodebaseDocument | null> {
    const filter: Record<string, unknown> = { _id: id };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<CodebaseDocument | null>;
  }

  /** Get a codebase by its unique slug (excludes soft-deleted by default). */
  async getBySlug(slug: string, opts?: { includeDeleted?: boolean }): Promise<CodebaseDocument | null> {
    const filter: Record<string, unknown> = { slug };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<CodebaseDocument | null>;
  }

  /** List codebases, newest first (excludes soft-deleted by default). */
  async list(opts?: { includeDeleted?: boolean }): Promise<CodebaseDocument[]> {
    const filter = opts?.includeDeleted ? {} : { deletedAt: { $exists: false } };
    return this.collection.find(filter).sort({ createdAt: -1 }).toArray();
  }

  /**
   * Create a new codebase. Generates a fresh UUID `_id`, derives/validates a
   * unique slug, and initializes the revision counter at 0.
   *
   * @throws if the resolved slug already exists, or if a git codebase is
   *         created without a `source`.
   */
  async create(input: CreateCodebaseInput): Promise<CodebaseDocument> {
    if (input.sourceType === "git" && !input.source?.trim()) {
      throw new Error("Git codebases require a 'source' (owner/repo)");
    }

    const baseSlug = slugifyCodebaseName(input.slug ?? input.name);
    if (!baseSlug) {
      throw new Error("Could not derive a valid slug from the codebase name");
    }
    const slug = await this.ensureUniqueSlug(baseSlug);

    const now = new Date();
    const doc: CodebaseDocument = {
      _id: randomUUID(),
      slug,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      sourceType: input.sourceType,
      ...(input.source ? { source: input.source } : {}),
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      revisionCounter: 0,
      ...(input.creator ? { creator: input.creator } : {}),
      createdAt: now,
    };

    await this.collection.insertOne(doc as CodebaseDocument);
    return doc;
  }

  /** Patch mutable metadata. Returns the updated document, or null if not found. */
  async update(id: string, patch: UpdateCodebaseInput): Promise<CodebaseDocument | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.defaultBranch !== undefined) set.defaultBranch = patch.defaultBranch;

    const result = await this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: set },
      { returnDocument: "after" }
    );
    return (result as CodebaseDocument | null) ?? null;
  }

  /** Soft-delete a codebase (sets `deletedAt`). Returns true if a doc was updated. */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Atomically allocate the next revision number for a codebase by `$inc`-ing
   * its `revisionCounter`. Concurrent callers receive distinct, gap-free numbers.
   *
   * @returns the newly allocated revision number, or null if the codebase is gone.
   */
  async allocateRevisionNumber(codebaseId: string): Promise<number | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: codebaseId, deletedAt: { $exists: false } } as object,
      { $inc: { revisionCounter: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    const doc = result as CodebaseDocument | null;
    return doc ? doc.revisionCounter : null;
  }

  /** Update the `latestRevisionId` pointer after a new revision is created. */
  async setLatestRevision(codebaseId: string, revisionId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: codebaseId } as object,
      { $set: { latestRevisionId: revisionId, updatedAt: new Date() } }
    );
  }

  /**
   * Find a slug not already taken, appending `-2`, `-3`, … as needed.
   * (Soft-deleted codebases still reserve their slug to keep refs stable.)
   */
  private async ensureUniqueSlug(base: string): Promise<string> {
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await this.collection.findOne({ slug: candidate } as object)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}
