// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SkillConfig, SkillRevisionDocument } from '../types/skill.js';

/**
 * Client for resolving skill revision refs via the Scope MT REST API.
 *
 * Used by queue processors at message-processing time to resolve
 * skill revision refs stored on RequestDocuments into SkillConfig
 * objects that can be passed to coding agent workers.
 */
export class SkillClient {
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  /**
   * Resolve an array of skill revision refs to their configurations.
   * Fetches each revision from the API and maps to SkillConfig.
   *
   * @param refs - Skill revision refs (e.g. "vercel-labs/agent-skills/my-skill@a1b2c3d")
   * @throws Error if any ref cannot be resolved (404 or HTTP error)
   */
  async resolveSkills(refs: string[]): Promise<SkillConfig[]> {
    if (refs.length === 0) return [];

    const configs: SkillConfig[] = [];

    for (const ref of refs) {
      const url = `${this.apiUrl}/api/v1/skill-revisions/by-ref/${encodeURIComponent(ref)}`;
      const res = await fetch(url);

      if (res.status === 404) {
        throw new Error(`Skill revision '${ref}' not found via API`);
      }
      if (!res.ok) {
        throw new Error(`[SkillClient] GET ${url} failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as SkillRevisionDocument;
      configs.push({
        name: data.name,
        description: data.description,
        content: data.content,
      });
    }

    return configs;
  }
}
