// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Cursor encoding/decoding for cursor-based pagination.
 *
 * Human-readable composite format (uses `~` as key-value separator
 * because `:` appears in ISO timestamps):
 *   Flat mode:  "createdAt~<ISO>|id~<_id>"
 *   Grouped:    "<fieldName>~<value>"  e.g. "taskPromptId~tp-1" or "submissionId~sub-1"
 */

const PIPE = "|";
const SEP = "~";

/** Flat cursor — position in the createdAt + _id sort space */
export interface FlatCursor {
  createdAt: string; // ISO string
  id: string;        // _id
}

/** Encode a flat cursor: "createdAt~<ISO>|id~<_id>" */
export function encodeFlatCursor(createdAt: string, id: string): string {
  return `createdAt${SEP}${createdAt}${PIPE}id${SEP}${id}`;
}

/** Decode a flat cursor string into its components */
export function decodeFlatCursor(encoded: string): FlatCursor {
  const parts = encoded.split(PIPE);
  if (parts.length !== 2) throw new Error("Invalid flat cursor: expected 2 parts");
  const createdAt = extractValue(parts[0], "createdAt");
  const id = extractValue(parts[1], "id");
  return { createdAt, id };
}

/** Encode a group cursor: "<fieldName>~<value>" */
export function encodeGroupCursor(fieldName: string, value: string): string {
  return `${fieldName}${SEP}${value}`;
}

/** Decode a group cursor string into field name and value */
export function decodeGroupCursor(encoded: string): { field: string; value: string } {
  const idx = encoded.indexOf(SEP);
  if (idx < 1) throw new Error("Invalid group cursor: missing '~'");
  return { field: encoded.slice(0, idx), value: encoded.slice(idx + 1) };
}

function extractValue(part: string, expectedKey: string): string {
  const idx = part.indexOf(SEP);
  if (idx < 1) throw new Error(`Invalid cursor part: missing '~'`);
  const key = part.slice(0, idx);
  if (key !== expectedKey) throw new Error(`Invalid cursor: expected '${expectedKey}', got '${key}'`);
  return part.slice(idx + 1);
}
