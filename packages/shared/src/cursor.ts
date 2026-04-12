// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Cursor encoding/decoding for cursor-based pagination.
 *
 * Flat-mode cursor: { c: "<createdAt ISO>", i: "<_id>" }
 * Grouped-mode cursor: { k: "<groupKey>" }
 */

/** Flat cursor — encodes position in the createdAt + _id sort space */
export interface FlatCursor {
  c: string; // createdAt ISO string
  i: string; // _id
}

/** Group cursor — encodes position in the group key space */
export interface GroupCursor {
  k: string; // group key (taskPromptId or submissionId)
}

export type Cursor = FlatCursor | GroupCursor;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(encoded: string): Cursor {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    // Validate shape
    if (typeof parsed === "object" && parsed !== null) {
      if ("c" in parsed && "i" in parsed && typeof parsed.c === "string" && typeof parsed.i === "string") {
        return parsed as FlatCursor;
      }
      if ("k" in parsed && typeof parsed.k === "string") {
        return parsed as GroupCursor;
      }
    }
    throw new Error("Invalid cursor shape");
  } catch {
    throw new Error("Invalid cursor");
  }
}

export function isFlatCursor(cursor: Cursor): cursor is FlatCursor {
  return "c" in cursor;
}

export function isGroupCursor(cursor: Cursor): cursor is GroupCursor {
  return "k" in cursor;
}
