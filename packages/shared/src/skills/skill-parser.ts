// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill SKILL.md parser.
 *
 * Parses a SKILL.md file according to the Agent Skills Specification:
 * https://agentskills.io/specification
 *
 * Parsing is intentionally lenient so that off-spec skills can still be
 * imported: the spec-required `name` and `description` fields are coerced to
 * strings and default to empty when missing rather than throwing. Spec
 * violations (including absent required fields) are surfaced downstream by the
 * validator as non-blocking warnings. The only unrecoverable failure is YAML
 * frontmatter that cannot be parsed at all.
 *
 * Uses `gray-matter` to extract YAML frontmatter and markdown body.
 */

import matter from 'gray-matter';

/** Parsed frontmatter fields from a SKILL.md file */
export interface SkillFrontmatter {
  name: string;                        // Required: 1-64 chars, lowercase alphanumeric + hyphens
  description: string;                 // Required: 1-1024 chars
  license?: string;                    // Optional
  compatibility?: string;             // Optional: 1-500 chars
  allowedTools?: string;              // Optional: space-delimited tool list
  metadata?: Record<string, string>;  // Optional: arbitrary key-value
}

/** Result of parsing a SKILL.md file */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;                     // Markdown body after frontmatter
  raw: string;                         // Original raw SKILL.md content
}

/**
 * Parse a SKILL.md file content into structured frontmatter and body.
 *
 * @param rawContent - The full text of the SKILL.md file
 * @returns ParsedSkill with frontmatter fields and markdown body
 * @throws Error if the YAML frontmatter cannot be parsed, or if the required
 *   `description` field is missing/empty (a skill with no description cannot be
 *   activated by an agent, so it is rejected rather than imported as a dead
 *   entry)
 */
export function parseSkillMd(rawContent: string): ParsedSkill {
  const { data, content } = matter(rawContent);

  // description is the agent's activation trigger and has no fallback — a skill
  // without one can never be invoked, so we reject it (rather than importing a
  // dead entry). name, by contrast, is recoverable from the parent directory
  // per spec, so a missing/non-string name is coerced to empty and the resolver
  // fills it in; the validator reports the resulting spec violation as a warning.
  if (!data.description || typeof data.description !== 'string') {
    throw new Error('SKILL.md missing required frontmatter field: description');
  }

  const frontmatter: SkillFrontmatter = {
    name: data.name != null ? String(data.name) : '',
    description: data.description,
  };

  if (data.license !== undefined) {
    frontmatter.license = String(data.license);
  }

  if (data.compatibility !== undefined) {
    frontmatter.compatibility = String(data.compatibility);
  }

  // allowed-tools uses a hyphen in the spec, but we store as camelCase
  const allowedTools = data['allowed-tools'] ?? data.allowedTools;
  if (allowedTools !== undefined) {
    frontmatter.allowedTools = String(allowedTools);
  }

  if (data.metadata !== undefined && typeof data.metadata === 'object' && data.metadata !== null) {
    // Ensure all values are strings
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.metadata)) {
      metadata[key] = String(value);
    }
    frontmatter.metadata = metadata;
  }

  return {
    frontmatter,
    content: content.trim(),
    raw: rawContent,
  };
}
