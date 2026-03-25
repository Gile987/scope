// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import type { ConversationTurn } from "@/types";
import {
  extractChronologicalSegments,
  extractFromHar,
  type ConversationSegment,
  type HarExtractedData,
  type HarFile,
  type ToolCall,
} from "@/lib/har-extraction";

export type { ConversationSegment, HarExtractedData, ToolCall };

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
    return extractFromHar(har);
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
  // Turns that already have pre-computed toolCalls don't need HAR fetching
  const preComputed = useMemo(() => {
    const out: AggregatedToolCall[] = [];
    if (turns) {
      for (const t of turns) {
        if (t.toolCalls && t.toolCalls.length > 0) {
          for (const tc of t.toolCalls) {
            out.push({ ...tc, timestamp: tc.timestamp ?? "", _iteration: t.iteration });
          }
        }
      }
    }
    return out;
  }, [turns]);

  // Build query descriptors only for turns that need HAR extraction
  const queries = useMemo(() => {
    const q: { iteration: number | undefined; enabled: boolean }[] = [];

    // One-shot run: top-level HAR, no iteration
    if (topLevelHarUrl && (!turns || turns.length === 0)) {
      q.push({ iteration: undefined, enabled: true });
    }

    // Multi-turn: one query per turn with harUrl but WITHOUT pre-computed toolCalls
    if (turns) {
      for (const t of turns) {
        if (t.harUrl && !(t.toolCalls && t.toolCalls.length > 0)) {
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
    const out: AggregatedToolCall[] = [...preComputed];
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
  }, [preComputed, results, queries]);

  const isLoading = results.some((r) => r.isLoading);

  return { allToolCalls, isLoading };
}
