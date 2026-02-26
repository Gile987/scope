// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import type { ToolCall, ConversationTurn } from "@/types";

// ---------------------------------------------------------------------------
// Minimal HAR types (matches HarNetworkViewer's types)
// ---------------------------------------------------------------------------
interface HarEntry {
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

interface HarFile {
  log: { entries: HarEntry[] };
}

// ---------------------------------------------------------------------------
// Chronological segment types
// ---------------------------------------------------------------------------
export type ConversationSegment =
  | { type: "thinking"; content: string }
  | { type: "content"; content: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

// ---------------------------------------------------------------------------
// HAR body helpers
// ---------------------------------------------------------------------------
function getResponseBody(entry: HarEntry): string | null {
  const content = entry.response?.content;
  if (!content?.text) return null;
  if (content.encoding === "base64") {
    try {
      // atob returns Latin-1; must re-decode as UTF-8 for multi-byte chars
      const binary = atob(content.text);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return null;
    }
  }
  return content.text;
}

// ---------------------------------------------------------------------------
// Collect tool responses from request bodies (global across all entries)
// ---------------------------------------------------------------------------
function extractToolResponses(body: string, responses: Map<string, string>): void {
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
function extractEntrySegments(
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
          if (contentParts.length > 0) segments.push({ type: "content", content: contentParts.join("") });
          if (tcs.length > 0) segments.push({ type: "tool_calls", toolCalls: tcs });
        } else if (contentParts.length > 0) {
          segments.push({ type: "content", content: contentParts.join("") });
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
    segments.push({ type: "thinking", content: thinkingParts.join("") });
  }
  if (contentParts.length > 0) {
    segments.push({ type: "content", content: contentParts.join("") });
  }
  if (partialToolCalls.size > 0) {
    const tcs: ToolCall[] = [];
    for (const [id, partial] of partialToolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(partial.arguments); } catch { args = { _raw: partial.arguments }; }
      const response = toolResponses.get(id);
      tcs.push({ id, name: partial.name, arguments: args, timestamp, ...(response && { response }) });
    }
    segments.push({ type: "tool_calls", toolCalls: tcs });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Main extraction: chronological segments across all HAR entries
// ---------------------------------------------------------------------------
function extractChronologicalSegments(har: HarFile): ConversationSegment[] {
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
// Extracted data shape
// ---------------------------------------------------------------------------
export interface HarExtractedData {
  /** All thinking content concatenated (backward compat) */
  thinkingContent: string;
  /** All tool calls aggregated (backward compat for Tool Calls tab) */
  toolCalls: ToolCall[];
  /** Chronological segments — interleaved thinking, content, and tool calls */
  segments: ConversationSegment[];
}

// ---------------------------------------------------------------------------
// Shared HAR data hook — single source of truth for fetching HAR JSON.
// All tabs (Conversation, Network, Tool Calls) share this cache.
// Generic so each consumer can use their own HAR type definition.
// ---------------------------------------------------------------------------
export function useHarData<T = unknown>(runId: string, iteration?: number, enabled = true) {
  return useQuery<T>({
    queryKey: ["har", runId, iteration],
    queryFn: async () => {
      const url = api.harUrl(runId, iteration);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled,
    staleTime: Infinity, // HAR data is immutable once created
  });
}

// ---------------------------------------------------------------------------
// React hook: fetch HAR for a turn and extract thinking + tool calls
// ---------------------------------------------------------------------------
export function useHarExtraction(runId: string, iteration?: number, hasHar?: boolean): {
  data: HarExtractedData | undefined;
  isLoading: boolean;
} {
  const { data: har, isLoading } = useHarData<HarFile>(runId, iteration, !!hasHar);

  const data = useMemo(() => {
    if (!har) return undefined;
    const segments = extractChronologicalSegments(har);
    // Derive flat aggregates from segments for backward compat
    const thinkingContent = segments
      .filter((s): s is ConversationSegment & { type: "thinking" } => s.type === "thinking")
      .map((s) => s.content)
      .join("");
    const toolCalls = segments
      .filter((s): s is ConversationSegment & { type: "tool_calls" } => s.type === "tool_calls")
      .flatMap((s) => s.toolCalls);
    return { thinkingContent, toolCalls, segments };
  }, [har]);

  return { data, isLoading };
}

// ---------------------------------------------------------------------------
// React hook: fetch HARs for ALL turns and aggregate tool calls
// ---------------------------------------------------------------------------
export interface AggregatedToolCall extends ToolCall {
  _iteration?: number;
}

export function useAllTurnsToolCalls(
  runId: string,
  turns?: ConversationTurn[],
  topLevelHarUrl?: string,
): { allToolCalls: AggregatedToolCall[]; isLoading: boolean } {
  // Build query descriptors: one per turn with harUrl + optional top-level (one-shot)
  const queries = useMemo(() => {
    const q: { iteration: number | undefined; enabled: boolean }[] = [];

    // One-shot run: top-level HAR, no iteration
    if (topLevelHarUrl && (!turns || turns.length === 0)) {
      q.push({ iteration: undefined, enabled: true });
    }

    // Multi-turn: one query per turn with harUrl
    if (turns) {
      for (const t of turns) {
        if (t.harUrl) {
          q.push({ iteration: t.iteration, enabled: true });
        }
      }
    }

    return q;
  }, [turns, topLevelHarUrl]);

  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ["har", runId, q.iteration],
      queryFn: async () => {
        const url = api.harUrl(runId, q.iteration);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HarFile>;
      },
      enabled: q.enabled,
      staleTime: Infinity,
    })),
  });

  const allToolCalls = useMemo(() => {
    const out: AggregatedToolCall[] = [];
    for (let i = 0; i < results.length; i++) {
      const har = results[i].data;
      if (!har) continue;
      const segments = extractChronologicalSegments(har);
      const tcs = segments
        .filter((s): s is ConversationSegment & { type: "tool_calls" } => s.type === "tool_calls")
        .flatMap((s) => s.toolCalls);
      const iteration = queries[i].iteration;
      for (const tc of tcs) {
        out.push({ ...tc, _iteration: iteration });
      }
    }
    return out;
  }, [results, queries]);

  const isLoading = results.some((r) => r.isLoading);

  return { allToolCalls, isLoading };
}
