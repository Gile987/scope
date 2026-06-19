// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Codebase Resolver — captures immutable snapshots of a codebase.
 *
 * Two entry points, both producing a new incremental revision:
 * - `resolveGit`: resolve a GitHub ref (branch/tag/sha or "latest") to a commit,
 *   download that tree as a tarball, normalize it, and store a revision.
 * - `createArchiveRevision`: accept an uploaded archive, normalize it, and store
 *   a revision.
 *
 * Mirrors the SkillResolver's GitHub auth model (static token or round-robin
 * token provider). Codebase revisions are purely incremental — every call
 * always creates a brand-new revision (no content-addressing/dedup).
 */

import { randomUUID, createHash } from "crypto";
import type { CodebaseDocument, CodebaseRevisionDocument } from "../types/codebase.js";
import type { CodebaseRevisionStore } from "./codebase-revision-store.js";
import { normalizeToRootTarGz } from "./codebase-archive.js";

/** Function that uploads archive bytes to blob storage and returns its URL. */
export type UploadArchiveFn = (blobName: string, data: Buffer) => Promise<string>;

/** Options for the codebase resolver (GitHub auth). */
export interface CodebaseResolverOptions {
  githubApiUrl?: string;
  githubToken?: string;
  tokenProvider?: () => Promise<string | undefined>;
}

/**
 * Build the blob key for a codebase revision archive.
 * Keyed by the immutable revision UUID so a re-numbering race can never
 * overwrite another revision's bytes.
 */
export function buildCodebaseArchiveBlobName(codebaseId: string, revisionId: string): string {
  return `codebase-revisions/${codebaseId}/${revisionId}.tar.gz`;
}

export class CodebaseResolver {
  private readonly githubApiUrl: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly staticToken?: string;
  private readonly tokenProvider?: () => Promise<string | undefined>;

  constructor(options?: CodebaseResolverOptions) {
    this.githubApiUrl = options?.githubApiUrl?.replace(/\/+$/, "") ?? "https://api.github.com";
    this.baseHeaders = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "scope-mt-codebase-resolver",
    };
    this.staticToken = options?.githubToken;
    this.tokenProvider = options?.tokenProvider;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    let token: string | undefined;
    if (this.tokenProvider) {
      try {
        token = await this.tokenProvider();
      } catch {
        // Provider failure is non-fatal — fall back to static token / unauth.
      }
    }
    if (!token) token = this.staticToken;
    if (!token) return this.baseHeaders;
    return { ...this.baseHeaders, Authorization: `Bearer ${token}` };
  }

  /**
   * Resolve a GitHub ref to an immutable revision.
   *
   * @param codebase - the parent git codebase (provides source + slug + defaultBranch).
   * @param requestedRef - branch/tag/sha or "latest"/undefined (→ default branch).
   * @param store - revision store for persistence.
   * @param uploadArchive - uploads the normalized tar.gz and returns its URL.
   * @param opts.creator - provenance for who triggered the resolution.
   */
  async resolveGit(
    codebase: CodebaseDocument,
    requestedRef: string | undefined,
    store: CodebaseRevisionStore,
    uploadArchive: UploadArchiveFn,
    opts?: { creator?: string }
  ): Promise<CodebaseRevisionDocument> {
    const source = codebase.source;
    if (!source) {
      throw new Error(`Codebase '${codebase.slug}' has no git source`);
    }

    // Resolve the effective ref. "latest"/empty → the repo's default branch.
    let effectiveRef = requestedRef?.trim();
    if (!effectiveRef || effectiveRef.toLowerCase() === "latest") {
      effectiveRef = codebase.defaultBranch || (await this.getDefaultBranch(source));
    }

    const commit = await this.getCommit(source, effectiveRef);

    // Download the repo tarball at the resolved commit and normalize it.
    const tarball = await this.downloadTarball(source, commit.sha);
    const normalized = await normalizeToRootTarGz(tarball);

    const revisionId = randomUUID();
    const blobName = buildCodebaseArchiveBlobName(codebase._id, revisionId);
    const archiveUrl = await uploadArchive(blobName, normalized.data);

    return store.createRevision(
      {
        codebaseId: codebase._id,
        slug: codebase.slug,
        sourceType: "git",
        source,
        requestedRef: requestedRef ?? effectiveRef,
        resolvedCommitSha: commit.sha,
        commitTimestamp: commit.date,
        archiveUrl,
        sizeBytes: normalized.sizeBytes,
        fileCount: normalized.fileCount,
        ...(opts?.creator ? { creator: opts.creator } : {}),
        resolvedAt: new Date(),
      },
      { id: revisionId }
    );
  }

  /**
   * Create a revision from an uploaded archive (tar.gz/tar/zip).
   *
   * @param codebase - the parent archive codebase.
   * @param upload - the uploaded bytes + original filename.
   * @param store - revision store for persistence.
   * @param uploadArchive - uploads the normalized tar.gz and returns its URL.
   */
  async createArchiveRevision(
    codebase: CodebaseDocument,
    upload: { buffer: Buffer; originalFilename?: string; creator?: string },
    store: CodebaseRevisionStore,
    uploadArchive: UploadArchiveFn
  ): Promise<CodebaseRevisionDocument> {
    const contentSha256 = createHash("sha256").update(upload.buffer).digest("hex");
    const normalized = await normalizeToRootTarGz(upload.buffer);

    const revisionId = randomUUID();
    const blobName = buildCodebaseArchiveBlobName(codebase._id, revisionId);
    const archiveUrl = await uploadArchive(blobName, normalized.data);

    return store.createRevision(
      {
        codebaseId: codebase._id,
        slug: codebase.slug,
        sourceType: "archive",
        ...(upload.originalFilename ? { originalFilename: upload.originalFilename } : {}),
        contentSha256,
        archiveUrl,
        sizeBytes: normalized.sizeBytes,
        fileCount: normalized.fileCount,
        ...(upload.creator ? { creator: upload.creator } : {}),
        resolvedAt: new Date(),
      },
      { id: revisionId }
    );
  }

  /** Get the default branch of a GitHub repo. */
  async getDefaultBranch(source: string): Promise<string> {
    const res = await fetch(`${this.githubApiUrl}/repos/${source}`, {
      headers: await this.getHeaders(),
    });
    if (res.status === 404) throw new Error(`Repository "${source}" not found`);
    if (!res.ok) {
      throw new Error(`Failed to access repository "${source}": ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { default_branch?: string };
    return json.default_branch ?? "main";
  }

  /** Resolve a ref (branch/tag/sha) to its commit sha + timestamp. */
  async getCommit(source: string, ref: string): Promise<{ sha: string; date: Date }> {
    const url = `${this.githubApiUrl}/repos/${source}/commits/${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: await this.getHeaders() });
    if (res.status === 404) {
      throw new Error(`Ref "${ref}" not found in repository "${source}"`);
    }
    if (!res.ok) {
      throw new Error(`Failed to resolve ${source}@${ref}: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      sha: string;
      commit: { committer?: { date?: string }; author?: { date?: string } };
    };
    const dateStr = json.commit?.committer?.date ?? json.commit?.author?.date;
    return { sha: json.sha, date: dateStr ? new Date(dateStr) : new Date() };
  }

  /** Download the repo tree as a tar.gz at the given ref/sha. */
  async downloadTarball(source: string, ref: string): Promise<Buffer> {
    const url = `${this.githubApiUrl}/repos/${source}/tarball/${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: await this.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to download tarball ${source}@${ref}: ${res.status} ${res.statusText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
