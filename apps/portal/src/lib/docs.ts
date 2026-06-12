// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Central helpers for linking from the portal into the public Scope docs site.
 *
 * The docs site is built with Astro Starlight and lives at the URL exposed via
 * the `aka.ms/projectscope/doc` short link. We centralise the URLs here so:
 *  - components only depend on a stable named key (not a hard-coded URL),
 *  - if the docs site moves or restructures, only this file needs to change.
 */

export const DOCS_BASE = "https://aka.ms/projectscope/doc";

/**
 * Named docs pages referenced by in-app tooltips and contextual help links.
 * Keys are stable identifiers used in components; values are the slug path
 * appended to `DOCS_BASE`. Trailing slashes match the Starlight URL pattern.
 */
export const DOCS_PAGES = {
  concepts: "/introduction/concepts/",
  criteria: "/guides/defining-criteria/",
  criteriaSchema: "/reference/criteria-schema/",
  profiles: "/guides/defining-profiles/",
  profileSchema: "/reference/profile-schema/",
  promptFeatures: "/guides/prompt-features/",
  promptFeatureSchema: "/reference/prompt-feature-schema/",
  skills: "/guides/importing-skills/",
  mcpServers: "/guides/importing-mcp-servers/",
  extensions: "/guides/importing-extensions/",
  taskPrompts: "/guides/managing-task-prompts/",
  choosingAgent: "/guides/choosing-a-coding-agent/",
  submitRunPortal: "/guides/submitting-requests-portal/",
  workers: "/reference/workers/",
  glossary: "/resources/glossary/",
} as const;

export type DocsPage = keyof typeof DOCS_PAGES;

/**
 * Build a full docs URL for a named page.
 */
export function docsUrl(page: DocsPage): string {
  return `${DOCS_BASE}${DOCS_PAGES[page]}`;
}
