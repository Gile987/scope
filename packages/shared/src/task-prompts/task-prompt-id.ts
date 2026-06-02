// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v5 as uuidv5 } from 'uuid';
import type { TaskPromptType } from '../types/types.js';

/**
 * Namespace UUID derived from 'task.scope-mt.dev' using the RFC 4122 DNS namespace.
 * Used to generate deterministic UUIDv5 identifiers for task prompts.
 */
export const TASK_PROMPT_NAMESPACE = uuidv5('task.scope-mt.dev', uuidv5.DNS);

/**
 * Compute a deterministic UUIDv5 for a task prompt from its text content (and type).
 *
 * The ID is content-addressed and **backward-compatible**:
 * - **`task` / undefined type**: derived from `uuidv5(text.trim(), NS)` — identical
 *   to the original scheme, so every existing task prompt keeps its exact `_id`.
 * - **Non-task types** (e.g. `agents.md`): the type is folded into the hash as
 *   `uuidv5(type + '\n' + text.trim(), NS)`, namespacing it so a prompt of one type
 *   never collides with an identical-text prompt of another type.
 *
 * Properties: content-addressed (same text+type → same ID), trim-insensitive,
 * standard 36-char hyphenated UUID.
 */
export function computeTaskPromptId(text: string, type?: TaskPromptType): string {
  const trimmed = text.trim();
  const namespaced =
    !type || type === 'task' ? trimmed : `${type}\n${trimmed}`;
  return uuidv5(namespaced, TASK_PROMPT_NAMESPACE);
}
