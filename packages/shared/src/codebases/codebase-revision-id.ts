// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Codebase revision addressing helpers.
 *
 * Unlike skill revisions, codebase revisions are NOT content-addressed. The
 * canonical ref is purely `"{slug}@r{revisionNumber}"` for both git and archive
 * source types, and a revision's `_id` is a fresh UUID assigned at creation.
 */

/**
 * Convert a human name into a URL-safe slug.
 * Lowercases, replaces runs of non-alphanumeric chars with a single hyphen,
 * and trims leading/trailing hyphens.
 */
export function slugifyCodebaseName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the canonical codebase revision ref string.
 *
 * Format: `{slug}@r{revisionNumber}` (e.g. `pamelafox-site@r3`).
 * The only ref form — identical for git and archive revisions.
 */
export function buildCodebaseRevisionRef(slug: string, revisionNumber: number): string {
  return `${slug}@r${revisionNumber}`;
}

/**
 * Parse a codebase revision ref back into its parts.
 *
 * - `"{slug}@r{N}"` → `{ slug, revisionNumber: N }`
 * - `"{slug}"` (no `@r…`) → `{ slug, revisionNumber: undefined }` (means "latest")
 * - anything else → `null`
 */
export function parseCodebaseRevisionRef(
  ref: string
): { slug: string; revisionNumber?: number } | null {
  const withRev = /^(.+)@r(\d+)$/.exec(ref);
  if (withRev) {
    return { slug: withRev[1], revisionNumber: Number(withRev[2]) };
  }
  if (ref.includes("@")) {
    // Has an '@' but not the expected '@r{N}' shape — invalid.
    return null;
  }
  if (!ref.trim()) return null;
  return { slug: ref };
}
