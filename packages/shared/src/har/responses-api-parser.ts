// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenAI Responses API tool-call extraction.
 *
 * gpt-5.x models (via Copilot) use the OpenAI Responses API (`POST /responses`,
 * SSE) instead of chat-completions. Tool calls arrive as `function_call` /
 * `custom_tool_call` items keyed by `call_id`, in two places:
 *   - response `response.output_item.done` SSE events / non-streaming `output[]`
 *   - the request `input[]` accumulated transcript, which also carries the
 *     matching `function_call_output` / `custom_tool_call_output` results.
 *
 * These extractors are consumed by `extractToolCalls` in `har-parser.ts`, which
 * unions both sources (deduped by `call_id`) with the OpenAI / Anthropic
 * parsers. Splitting them out keeps `har-parser.ts` focused on orchestration
 * and the shared HAR utilities.
 */

import type { ToolCall } from "./types.js";

/**
 * Build a ToolCall from an OpenAI Responses API item.
 *
 * Handles the two tool-call item shapes (identical whether they appear in a
 * response `output_item.done` event or the request `input[]` transcript):
 *   { type: "function_call",    name, call_id, arguments: "<json-string>" }
 *   { type: "custom_tool_call", name, call_id, input: "<raw string>" }
 *
 * The stable identifier is `call_id` (matched against `*_output` results);
 * the item's opaque `id` field must not be used. Returns null for any other
 * item type or when `call_id` is missing.
 */
function responsesApiItemToToolCall(
  item: Record<string, unknown>,
  timestamp: string,
): ToolCall | null {
  const callId = item.call_id;
  if (typeof callId !== "string" || !callId) return null;

  if (item.type === "function_call") {
    let parsedArgs: Record<string, unknown> = {};
    const rawArgs = item.arguments;
    if (typeof rawArgs === "string" && rawArgs) {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        parsedArgs = { _raw: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      parsedArgs = rawArgs as Record<string, unknown>;
    }
    return {
      id: callId,
      name: (item.name as string) || "unknown",
      arguments: parsedArgs,
      timestamp,
    };
  }

  if (item.type === "custom_tool_call") {
    const input = item.input;
    return {
      id: callId,
      name: (item.name as string) || "unknown",
      // Custom tool input is a freeform string (e.g. an apply_patch payload),
      // not JSON — preserve it verbatim under `_raw`.
      arguments: typeof input === "string" ? { _raw: input } : {},
      timestamp,
    };
  }

  return null;
}

/**
 * Extract Responses API tool calls from a *response* body.
 *
 * gpt-5.x via Copilot uses the Responses API (POST /responses). Tool calls are
 * emitted as `response.output_item.done` SSE events whose `.item` is a
 * `function_call` or `custom_tool_call`. The `output_item.done` event carries
 * the complete item, so no streaming-delta accumulation is needed. Non-streaming
 * responses carry the same items in a top-level `output[]` array.
 *
 * Response events are the only place the terminal call (e.g. `task_complete`)
 * appears, since the agent stops afterwards and never echoes it into a later
 * request transcript.
 */
export function extractResponsesApiToolCallsFromBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Non-streaming Responses API: { output: [ {type:"function_call", ...}, ... ] }
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json.output)) {
      for (const item of json.output) {
        if (item && typeof item === "object") {
          const call = responsesApiItemToToolCall(item as Record<string, unknown>, timestamp);
          if (call && !toolCalls.has(call.id)) toolCalls.set(call.id, call);
        }
      }
      return;
    }
  } catch {
    // Not a single JSON object — try SSE streaming below.
  }

  // Streaming SSE: data: {"type":"response.output_item.done","item":{...}}
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

    try {
      const json = JSON.parse(trimmed.slice(6));
      if (json.type !== "response.output_item.done") continue;
      const item = json.item;
      if (!item || typeof item !== "object") continue;
      const call = responsesApiItemToToolCall(item as Record<string, unknown>, timestamp);
      if (call && !toolCalls.has(call.id)) toolCalls.set(call.id, call);
    } catch {
      continue;
    }
  }
}

/**
 * Extract Responses API tool calls *and* their outputs from a *request* body.
 *
 * Each `/responses` request re-sends the full running transcript in `input[]`,
 * which accumulates every prior `function_call` / `custom_tool_call` and the
 * matching `function_call_output` / `custom_tool_call_output`. Because a HAR may
 * retain only the tail of a long agent session, this accumulated request
 * transcript is the most complete source of the tool-call history — far more
 * complete than the sparse per-turn response events. Calls are added (deduped by
 * `call_id`); outputs are recorded in `toolResponses` for later matching.
 *
 * Parses the body once and dispatches on item type. `input` may also be a plain
 * string (simple prompts) — those bodies are ignored.
 */
export function extractResponsesApiFromRequestBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
  toolResponses: Map<string, string>,
): void {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }

  const input = json.input;
  if (!Array.isArray(input)) return;

  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = item.type;

    if (type === "function_call" || type === "custom_tool_call") {
      const call = responsesApiItemToToolCall(item, timestamp);
      if (call && !toolCalls.has(call.id)) toolCalls.set(call.id, call);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = item.call_id;
      if (typeof callId === "string" && callId && !toolResponses.has(callId)) {
        const output = item.output;
        const outStr =
          typeof output === "string"
            ? output
            : output != null
              ? JSON.stringify(output)
              : "";
        toolResponses.set(callId, outStr);
      }
    }
  }
}
