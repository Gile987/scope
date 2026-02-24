// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SkillConfig } from '../types/skill.js';

/**
 * Format skill configs into a prompt preamble that can be prepended to the task message.
 *
 * Uses XML-structured format for clear delineation:
 * ```
 * <skills>
 * <skill name="my-skill">
 * ...skill content (markdown body from SKILL.md)...
 * </skill>
 * </skills>
 * ```
 *
 * Returns an empty string if no skills are provided.
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

/**
 * Prepend skill context to a task message.
 * If no skills are provided, returns the original message unchanged.
 */
export function prependSkillsToMessage(
  message: string,
  skills?: SkillConfig[]
): string {
  if (!skills || skills.length === 0) {
    return message;
  }

  const preamble = formatSkillsPrompt(skills);
  return `${preamble}\n\n${message}`;
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
