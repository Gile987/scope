// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v5 as uuidv5 } from 'uuid';
import type { PromptType } from '../types/types.js';

/**
 * Namespace UUID derived from 'task.scope-mt.dev' using the RFC 4122 DNS namespace.
 * Used to generate deterministic UUIDv5 identifiers for task prompts.
 */
export const TASK_PROMPT_NAMESPACE = uuidv5('task.scope-mt.dev', uuidv5.DNS);

/**
 * Compute a deterministic UUIDv5 for a task (Select) prompt from its text content.
 *
 * The ID is derived from `uuidv5(text.trim(), TASK_PROMPT_NAMESPACE)`, making it:
 * - **Content-addressed**: same text always produces the same ID
 * - **Trim-insensitive**: leading/trailing whitespace is ignored
 * - **Standard UUID format**: 36-char hyphenated UUID, consistent with the rest of the codebase
 *
 * Equivalent to `computePromptId('select', text)`. Retained as the canonical
 * helper for Select/task prompts so existing ids remain stable.
 */
export function computeTaskPromptId(text: string): string {
  return uuidv5(text.trim(), TASK_PROMPT_NAMESPACE);
}

/**
 * Compute a deterministic UUIDv5 for a typed gate prompt.
 *
 * Content-addressing is **asymmetric by design** so existing Select (task)
 * prompts keep their exact ids:
 * - `select` → hashes the trimmed text only (identical to {@link computeTaskPromptId}).
 * - every other gate → namespaces the hash with `"${type}\n${text}"`.
 *
 * The same text under, say, `build` vs `test` therefore yields two distinct
 * documents, and a typed gate prompt can never collide with a legacy Select
 * prompt of the same text.
 */
export function computePromptId(type: PromptType, text: string): string {
  const trimmed = text.trim();
  return type === 'select'
    ? uuidv5(trimmed, TASK_PROMPT_NAMESPACE)
    : uuidv5(`${type}\n${trimmed}`, TASK_PROMPT_NAMESPACE);
}
