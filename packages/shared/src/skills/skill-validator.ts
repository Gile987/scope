// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill SKILL.md frontmatter validator.
 *
 * Validates parsed frontmatter fields according to the Agent Skills Specification:
 * https://agentskills.io/specification
 *
 * Validation is intentionally lenient: spec *constraint* violations (length and
 * format limits) are reported as non-blocking warnings so that skills which do
 * not strictly meet the spec can still be imported. Only genuinely-missing
 * required fields (`name`, `description`) are reported as blocking errors.
 */

import type { SkillFrontmatter } from './skill-parser.js';

/** A single validation error */
export interface SkillValidationError {
  field: string;
  message: string;
}

/** A single validation warning (non-blocking) */
export interface SkillValidationWarning {
  field: string;
  message: string;
}

/** Result of validating SKILL.md frontmatter */
export interface SkillValidationResult {
  valid: boolean;
  errors: SkillValidationError[];
  warnings: SkillValidationWarning[];
}

/**
 * Regex for the `name` field per spec:
 * - Lowercase alphanumeric characters and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 * - 1-64 characters
 */
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate SKILL.md frontmatter fields per the Agent Skills Specification.
 *
 * @param frontmatter - Parsed frontmatter to validate
 * @param dirName - Parent directory name (spec requires name to match it)
 * @returns Validation result with any errors
 */
export function validateSkillFrontmatter(
  frontmatter: SkillFrontmatter,
  dirName?: string
): SkillValidationResult {
  const errors: SkillValidationError[] = [];
  const warnings: SkillValidationWarning[] = [];

  // name: a missing name is recoverable (SkillResolver falls back to the parent
  // directory name, which the spec requires the name to match), so it is a
  // non-blocking warning rather than an error. Length/format limits are likewise
  // non-blocking warnings so off-spec skills can still be imported.
  if (!frontmatter.name) {
    warnings.push({ field: 'name', message: 'name missing - recovered from parent directory' });
  } else {
    if (frontmatter.name.length > 64) {
      warnings.push({ field: 'name', message: `name must be at most 64 characters (got ${frontmatter.name.length})` });
    }
    if (!NAME_REGEX.test(frontmatter.name)) {
      warnings.push({ field: 'name', message: 'name must contain only lowercase alphanumeric characters and hyphens, must not start or end with a hyphen' });
    }
    if (frontmatter.name.includes('--')) {
      warnings.push({ field: 'name', message: 'name must not contain consecutive hyphens (--)' });
    }
    if (dirName && frontmatter.name !== dirName) {
      warnings.push({ field: 'name', message: `name "${frontmatter.name}" does not match parent directory name "${dirName}" (spec recommends they match)` });
    }
  }

  // description: required (presence is a hard error); the 1024-char limit is a
  // non-blocking warning.
  if (!frontmatter.description) {
    errors.push({ field: 'description', message: 'description is required' });
  } else if (frontmatter.description.length > 1024) {
    warnings.push({ field: 'description', message: `description must be at most 1024 characters (got ${frontmatter.description.length})` });
  }

  // compatibility: optional; the 500-char limit is a non-blocking warning.
  if (frontmatter.compatibility !== undefined && frontmatter.compatibility.length > 500) {
    warnings.push({ field: 'compatibility', message: `compatibility must be at most 500 characters (got ${frontmatter.compatibility.length})` });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
