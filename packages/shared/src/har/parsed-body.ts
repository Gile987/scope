// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared body-parsing helpers for the HAR tool-call extractors.
 *
 * A single HAR response body is consumed by several format-specific parsers
 * (OpenAI chat-completions, Anthropic Messages, OpenAI Responses). Each one
 * used to re-run `JSON.parse` (and, for streaming bodies, re-split and
 * re-parse every SSE line) on the same body. Parsing the body once here and
 * handing every parser the pre-parsed result removes that redundant work
 * (up to 3x per response body) while keeping each parser's format-specific
 * logic self-contained.
 */

/** A HAR body parsed once, ready to be dispatched to every format parser. */
export interface ParsedBody {
  /**
   * The whole body parsed as a single JSON value, or `null` when the body is
   * not a single JSON document (e.g. an SSE stream, or malformed input).
   */
  json: unknown;
  /**
   * The parsed payload of each `data:` SSE line, in order. Empty when the body
   * is a single JSON document (i.e. when `json` is set).
   */
  sseEvents: unknown[];
}

/**
 * Parse a body as a single JSON value, returning `null` if it isn't valid
 * JSON. Note that a body of literal `"null"` also yields `null`; callers must
 * guard against non-object values before dereferencing.
 */
export function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Parse a HAR response body once. If the whole body is a single JSON document
 * it is returned as `json` (with no `sseEvents`); otherwise the body is treated
 * as an SSE stream and each `data:` line is parsed into `sseEvents`, skipping
 * `data: [DONE]` and any malformed line. `json` and a non-empty `sseEvents` are
 * mutually exclusive.
 */
export function parseBody(body: string): ParsedBody {
  try {
    return { json: JSON.parse(body), sseEvents: [] };
  } catch {
    // Not a single JSON document — parse as an SSE stream below.
  }

  const sseEvents: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
    try {
      sseEvents.push(JSON.parse(trimmed.slice(6)));
    } catch {
      // Skip malformed SSE payloads.
    }
  }
  return { json: null, sseEvents };
}
