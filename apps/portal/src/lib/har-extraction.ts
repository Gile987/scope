// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Pure functions for extracting structured data from HAR files.
 * No React dependencies — can be tested directly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    postData?: { text?: string };
  };
  response: {
    content: {
      text?: string;
      encoding?: string;
    };
  };
}

export interface HarFile {
  log: { entries: HarEntry[] };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp: string;
  response?: string;
}

export type ConversationSegment =
  | { type: "thinking"; content: string; timestamp: string }
  | { type: "content"; content: string; timestamp: string }
  | { type: "tool_calls"; toolCalls: ToolCall[]; timestamp: string };

export interface HarExtractedData {
  /** All thinking content concatenated */
  thinkingContent: string;
  /** All tool calls aggregated */
  toolCalls: ToolCall[];
  /** Chronological segments — interleaved thinking, content, and tool calls */
  segments: ConversationSegment[];
}

// ---------------------------------------------------------------------------
// Mojibake repair
// ---------------------------------------------------------------------------
/**
 * Re-encode a string from Latin-1 code points back to UTF-8.
 * Fixes "mojibake" where UTF-8 bytes were stored as Latin-1 characters
 * (e.g. ├ → â\x94\x9c). Only applied when the text contains telltale
 * mojibake patterns.
 */
export function repairMojibake(text: string): string {
  // Quick check: â (U+00E2) followed by control-range chars is a strong
  // signal that UTF-8 bytes were interpreted as Latin-1.
  if (!/\xc2[\x80-\xbf]|\xc3[\x80-\xbf]|\xe2[\x80-\xbf]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// HAR body helpers
// ---------------------------------------------------------------------------
export function getResponseBody(entry: HarEntry): string | null {
  const content = entry.response?.content;
  if (!content?.text) return null;
  if (content.encoding === "base64") {
    try {
      const binary = atob(content.text);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return null;
    }
  }
  return repairMojibake(content.text);
}

// ---------------------------------------------------------------------------
// Collect tool responses from request bodies
// ---------------------------------------------------------------------------
export function extractToolResponses(body: string, responses: Map<string, string>): void {
  try {
    const json = JSON.parse(body);
    if (!Array.isArray(json.messages)) return;
    for (const msg of json.messages) {
      if (msg.role === "tool" && msg.tool_call_id && msg.content) {
        responses.set(msg.tool_call_id, typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
    }
  } catch { /* skip */ }
}

// ---------------------------------------------------------------------------
// Extract segments from a single HAR entry's response body.
// Each entry = one LLM roundtrip.  Within an entry, the order is:
//   thinking → content → tool_calls
// ---------------------------------------------------------------------------
export function extractEntrySegments(
  body: string,
  timestamp: string,
  toolResponses: Map<string, string>,
): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  const thinkingParts: string[] = [];
  const contentParts: string[] = [];

  // --- Try non-streaming (single JSON response) first ---
  try {
    const json = JSON.parse(body);
    const choices = json.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const msg = choice.message;
        if (!msg) continue;
        if (typeof msg.content === "string" && msg.content) {
          contentParts.push(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) {
          const tcs: ToolCall[] = [];
          for (const tc of msg.tool_calls) {
            if (!tc.id) continue;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { args = { _raw: tc.function?.arguments }; }
            const response = toolResponses.get(tc.id);
            tcs.push({ id: tc.id, name: tc.function?.name || "unknown", arguments: args, timestamp, ...(response && { response }) });
          }
          if (contentParts.length > 0) segments.push({ type: "content", content: contentParts.join(""), timestamp });
          if (tcs.length > 0) segments.push({ type: "tool_calls", toolCalls: tcs, timestamp });
        } else if (contentParts.length > 0) {
          segments.push({ type: "content", content: contentParts.join(""), timestamp });
        }
      }
      return segments;
    }
  } catch { /* streaming — fall through */ }

  // --- SSE streaming ---
  const partialToolCalls: Map<string, { name: string; arguments: string }> = new Map();
  const indexToId: Map<number, string> = new Map();
  let nextAutoIndex = 0;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
    try {
      const json = JSON.parse(trimmed.slice(6));
      const choices = json.choices;
      if (!Array.isArray(choices)) continue;
      for (const choice of choices) {
        const delta = choice.delta;
        if (!delta) continue;

        // Thinking
        if (typeof delta.reasoning_text === "string" && delta.reasoning_text) thinkingParts.push(delta.reasoning_text);
        if (typeof delta.thinking === "string" && delta.thinking) thinkingParts.push(delta.thinking);

        // Content
        if (typeof delta.content === "string" && delta.content) contentParts.push(delta.content);

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              partialToolCalls.set(tc.id, { name: tc.function?.name || "", arguments: tc.function?.arguments || "" });
              const idx = tc.index ?? nextAutoIndex;
              indexToId.set(idx, tc.id);
              nextAutoIndex = idx + 1;
            } else if (tc.index !== undefined) {
              const id = indexToId.get(tc.index);
              if (id) {
                const partial = partialToolCalls.get(id);
                if (partial && tc.function?.arguments) partial.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    } catch { continue; }
  }

  // Build segments in chronological order: thinking → content → tool_calls
  if (thinkingParts.length > 0) {
    segments.push({ type: "thinking", content: thinkingParts.join(""), timestamp });
  }
  if (contentParts.length > 0) {
    segments.push({ type: "content", content: contentParts.join(""), timestamp });
  }
  if (partialToolCalls.size > 0) {
    const tcs: ToolCall[] = [];
    for (const [id, partial] of partialToolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(partial.arguments); } catch { args = { _raw: partial.arguments }; }
      const response = toolResponses.get(id);
      tcs.push({ id, name: partial.name, arguments: args, timestamp, ...(response && { response }) });
    }
    segments.push({ type: "tool_calls", toolCalls: tcs, timestamp });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Main extraction: chronological segments across all HAR entries
// ---------------------------------------------------------------------------
export function extractChronologicalSegments(har: HarFile): ConversationSegment[] {
  // First pass: collect all tool responses from request bodies
  const toolResponses = new Map<string, string>();
  for (const entry of har.log.entries) {
    const requestBody = entry.request?.postData?.text;
    if (requestBody) {
      extractToolResponses(requestBody, toolResponses);
    }
  }

  // Second pass: extract segments per entry in chronological order
  const segments: ConversationSegment[] = [];
  for (const entry of har.log.entries) {
    const body = getResponseBody(entry);
    if (!body) continue;
    segments.push(...extractEntrySegments(body, entry.startedDateTime, toolResponses));
  }

  return segments;
}

// ---------------------------------------------------------------------------
// High-level extraction: returns flat aggregates + chronological segments
// ---------------------------------------------------------------------------
export function extractFromHar(har: HarFile): HarExtractedData {
  const segments = extractChronologicalSegments(har);
  const thinkingContent = segments
    .filter((s): s is ConversationSegment & { type: "thinking" } => s.type === "thinking")
    .map((s) => s.content)
    .join("");
  const toolCalls = segments
    .filter((s): s is ConversationSegment & { type: "tool_calls" } => s.type === "tool_calls")
    .flatMap((s) => s.toolCalls);
  return { thinkingContent, toolCalls, segments };
}
