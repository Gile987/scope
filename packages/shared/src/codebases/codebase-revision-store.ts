// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { CodebaseRevisionDocument } from "../types/codebase.js";
import type { CodebaseStore } from "./codebase-store.js";
import {
  buildCodebaseRevisionRef,
  parseCodebaseRevisionRef,
} from "./codebase-revision-id.js";

/**
 * Fields the caller supplies when creating a revision. The generated fields
 * (`_id`, `revisionNumber`, `ref`, `createdAt`) are assigned by the store.
 */
export type CreateCodebaseRevisionInput = Omit<
  CodebaseRevisionDocument,
  "_id" | "revisionNumber" | "ref" | "createdAt"
>;

/**
 * MongoDB-backed store for the immutable `codebase-revisions` collection.
 *
 * Revisions are **purely incremental**: every call to {@link createRevision}
 * allocates the next `revisionNumber` (via the codebase's atomic counter) and
 * inserts a brand-new immutable document. There is no deduplication — uploading
 * identical bytes or re-resolving the same git SHA still creates a new revision.
 * Existing revisions are never mutated.
 */
export class CodebaseRevisionStore {
  constructor(
    private collection: Collection<CodebaseRevisionDocument>,
    private codebaseStore: CodebaseStore
  ) {}

  /** Get a revision by its UUID `_id`. */
  async get(id: string): Promise<CodebaseRevisionDocument | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Get a revision by its canonical `{slug}@r{N}` ref. */
  async getByRef(ref: string): Promise<CodebaseRevisionDocument | null> {
    const parsed = parseCodebaseRevisionRef(ref);
    if (!parsed || parsed.revisionNumber === undefined) return null;
    return this.collection.findOne({
      slug: parsed.slug,
      revisionNumber: parsed.revisionNumber,
    });
  }

  /** Get a specific revision number within a codebase. */
  async getByNumber(
    codebaseId: string,
    revisionNumber: number
  ): Promise<CodebaseRevisionDocument | null> {
    return this.collection.findOne({ codebaseId, revisionNumber });
  }

  /** Get the latest (highest-numbered) revision for a codebase, or null. */
  async getLatest(codebaseId: string): Promise<CodebaseRevisionDocument | null> {
    const [latest] = await this.collection
      .find({ codebaseId })
      .sort({ revisionNumber: -1 })
      .limit(1)
      .toArray();
    return latest ?? null;
  }

  /** List revisions for a codebase, newest first. */
  async listByCodebase(
    codebaseId: string,
    opts?: { limit?: number }
  ): Promise<CodebaseRevisionDocument[]> {
    return this.collection
      .find({ codebaseId })
      .sort({ revisionNumber: -1 })
      .limit(opts?.limit ?? 100)
      .toArray();
  }

  /**
   * Create a new immutable revision. Atomically allocates the next
   * `revisionNumber` from the parent codebase, builds the `{slug}@r{N}` ref,
   * inserts the document, and advances the codebase's `latestRevisionId`.
   *
   * @throws if the parent codebase does not exist (or was deleted).
   */
  async createRevision(
    input: CreateCodebaseRevisionInput
  ): Promise<CodebaseRevisionDocument> {
    const revisionNumber = await this.codebaseStore.allocateRevisionNumber(
      input.codebaseId
    );
    if (revisionNumber === null) {
      throw new Error(`Codebase '${input.codebaseId}' not found — cannot create revision`);
    }

    const doc: CodebaseRevisionDocument = {
      ...input,
      _id: randomUUID(),
      revisionNumber,
      ref: buildCodebaseRevisionRef(input.slug, revisionNumber),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as CodebaseRevisionDocument);
    await this.codebaseStore.setLatestRevision(input.codebaseId, doc._id);
    return doc;
  }

  /**
   * Delete all revisions for a codebase. Used when a codebase is hard-deleted
   * to clean up associated revision data.
   *
   * @returns the number of deleted revision documents.
   */
  async deleteByCodebase(codebaseId: string): Promise<number> {
    const result = await this.collection.deleteMany({ codebaseId });
    return result.deletedCount;
  }
}
