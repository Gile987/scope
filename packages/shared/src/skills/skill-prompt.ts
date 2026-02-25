// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SkillConfig } from '../types/skill.js';

/**
 * Format a lightweight discovery prompt listing available skills.
 *
 * Instead of injecting full skill content (which wastes tokens and bypasses
 * progressive disclosure), this generates a compact `<available_skills>` block
 * with just the metadata (~100 tokens per skill). The agent discovers the full
 * content by reading SKILL.md files from the workspace filesystem.
 *
 * Example output:
 * ```
 * <available_skills>
 * <skill name="azure-functions" location=".agents/skills/azure-functions">
 * Deploy and manage Azure Functions with best practices for triggers, bindings, and scaling.
 * </skill>
 * </available_skills>
 * ```
 *
 * @param skills - Resolved skill configs (name + description)
 * @param basePath - Base directory for skills (default: ".agents/skills")
 * @returns Discovery prompt string, or empty string if no skills
 */
export function formatSkillsDiscoveryPrompt(
  skills: SkillConfig[],
  basePath: string = '.agents/skills'
): string {
  if (!skills || skills.length === 0) {
    return '';
  }

  const skillBlocks = skills
    .map((s) => {
      const location = `${basePath}/${s.name}`;
      return `<skill name="${escapeXmlAttr(s.name)}" location="${escapeXmlAttr(location)}">\n${s.description.trim()}\n</skill>`;
    })
    .join('\n');

  return `<available_skills>\n${skillBlocks}\n</available_skills>`;
}

/**
 * Prepend skill discovery context to a task message.
 * If no skills are provided, returns the original message unchanged.
 *
 * Uses the lightweight discovery format — agents read full content
 * from the filesystem at `.agents/skills/<name>/SKILL.md`.
 */
export function prependSkillsToMessage(
  message: string,
  skills?: SkillConfig[],
  basePath?: string
): string {
  if (!skills || skills.length === 0) {
    return message;
  }

  const preamble = formatSkillsDiscoveryPrompt(skills, basePath);
  return `${preamble}\n\n${message}`;
}

// --- Legacy functions (kept for backward compatibility) ---

/**
 * Format skill configs into a full-content prompt preamble.
 *
 * @deprecated Use `formatSkillsDiscoveryPrompt()` instead — full content is now
 * delivered via the filesystem, not prompt injection.
 */
export function formatSkillsPrompt(skills: SkillConfig[]): string {
  if (!skills || skills.length === 0) {
    return '';
  }

  const skillBlocks = skills
    .map(
      (s) =>
        `<skill name="${escapeXmlAttr(s.name)}">\n${s.content.trim()}\n</skill>`
    )
    .join('\n');

  return `<skills>\n${skillBlocks}\n</skills>`;
}

/** Escape special characters in XML attribute values */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
