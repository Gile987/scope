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
// HAR body helpers
// ---------------------------------------------------------------------------
function getResponseBody(entry: HarEntry): string | null {
  const content = entry.response?.content;
  if (!content?.text) return null;
  if (content.encoding === "base64") {
    try {
      return atob(content.text);
    } catch {
      return null;
    }
  }
  return content.text;
}

// ---------------------------------------------------------------------------
// Extraction: thinking / reasoning content
// ---------------------------------------------------------------------------
function extractThinkingFromHar(har: HarFile): string {
  const parts: string[] = [];

  for (const entry of har.log.entries) {
    const body = getResponseBody(entry);
    if (!body) continue;

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
          if (typeof delta.reasoning_text === "string" && delta.reasoning_text) {
            parts.push(delta.reasoning_text);
          }
          if (typeof delta.thinking === "string" && delta.thinking) {
            parts.push(delta.thinking);
          }
        }
      } catch {
        continue;
      }
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Extraction: tool calls (mirrors shared/har-parser extractToolCalls logic)
// ---------------------------------------------------------------------------
function extractToolCallsFromHar(har: HarFile): ToolCall[] {
  const toolCalls: Map<string, ToolCall> = new Map();
  const toolResponses: Map<string, string> = new Map();

  for (const entry of har.log.entries) {
    const responseBody = getResponseBody(entry);
    if (responseBody) {
      extractFromResponseBody(responseBody, entry.startedDateTime, toolCalls);
    }

    const requestBody = entry.request?.postData?.text;
    if (requestBody) {
      extractToolResponses(requestBody, toolResponses);
    }
  }

  for (const [id, response] of toolResponses) {
    const tc = toolCalls.get(id);
    if (tc) tc.response = response;
  }

  return Array.from(toolCalls.values());
}

function extractFromResponseBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Try non-streaming first
  try {
    const json = JSON.parse(body);
    const choices = json.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const msg = choice.message;
        if (!msg?.tool_calls) continue;
        for (const tc of msg.tool_calls) {
          if (!tc.id || toolCalls.has(tc.id)) continue;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { args = { _raw: tc.function?.arguments }; }
          toolCalls.set(tc.id, { id: tc.id, name: tc.function?.name || "unknown", arguments: args, timestamp });
        }
      }
      return;
    }
  } catch { /* streaming */ }

  // SSE streaming
  const partialCalls: Map<string, { name: string; arguments: string }> = new Map();
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
        if (!delta?.tool_calls) continue;
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            partialCalls.set(tc.id, { name: tc.function?.name || "", arguments: tc.function?.arguments || "" });
            const idx = tc.index ?? nextAutoIndex;
            indexToId.set(idx, tc.id);
            nextAutoIndex = idx + 1;
          } else if (tc.index !== undefined) {
            const id = indexToId.get(tc.index);
            if (id) {
              const partial = partialCalls.get(id);
              if (partial && tc.function?.arguments) partial.arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch { continue; }
  }

  for (const [id, partial] of partialCalls) {
    if (toolCalls.has(id)) continue;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(partial.arguments); } catch { args = { _raw: partial.arguments }; }
    toolCalls.set(id, { id, name: partial.name, arguments: args, timestamp });
  }
}

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
// Extracted data shape
// ---------------------------------------------------------------------------
export interface HarExtractedData {
  thinkingContent: string;
  toolCalls: ToolCall[];
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
    return {
      thinkingContent: extractThinkingFromHar(har),
      toolCalls: extractToolCallsFromHar(har),
    };
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
      const tcs = extractToolCallsFromHar(har);
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
