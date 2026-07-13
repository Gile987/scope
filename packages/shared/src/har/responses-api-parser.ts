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
import type { HarWebSocketMessage } from "./types.js";
import type { ParsedBody } from "./parsed-body.js";
import { tryParseJson } from "./parsed-body.js";

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
 * Extract Responses API tool calls from a parsed *response* body.
 *
 * gpt-5.x via Copilot uses the Responses API (POST /responses). Tool calls are
 * emitted as `response.output_item.done` SSE events whose `.item` is a
 * `function_call` or `custom_tool_call`. The `output_item.done` event carries
 * the complete item, so no streaming-delta accumulation is needed. Non-streaming
 * responses carry the same items in a top-level `output[]` array.
 *
 * Takes a {@link ParsedBody} (the response body parsed once by the caller): the
 * non-streaming `output[]` is read from `parsed.json`, and the streaming events
 * from `parsed.sseEvents`.
 *
 * Response events are the only place the terminal call (e.g. `task_complete`)
 * appears, since the agent stops afterwards and never echoes it into a later
 * request transcript.
 */
export function extractResponsesApiToolCallsFromBody(
  parsed: ParsedBody,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Non-streaming Responses API: { output: [ {type:"function_call", ...}, ... ] }
  if (parsed.json && typeof parsed.json === "object") {
    const output = (parsed.json as Record<string, unknown>).output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item && typeof item === "object") {
          const call = responsesApiItemToToolCall(item as Record<string, unknown>, timestamp);
          if (call && !toolCalls.has(call.id)) toolCalls.set(call.id, call);
        }
      }
    }
  }

  // Streaming SSE: data: {"type":"response.output_item.done","item":{...}}
  // (parsed.sseEvents is empty for a non-streaming body, so the two branches
  // are mutually exclusive.)
  for (const event of parsed.sseEvents) {
    if (!event || typeof event !== "object") continue;
    const ev = event as Record<string, unknown>;
    if (ev.type !== "response.output_item.done") continue;
    const item = ev.item;
    if (!item || typeof item !== "object") continue;
    const call = responsesApiItemToToolCall(item as Record<string, unknown>, timestamp);
    if (call && !toolCalls.has(call.id)) toolCalls.set(call.id, call);
  }
}

/**
 * Extract Responses API tool calls *and* their outputs from a parsed *request*
 * body.
 *
 * Each `/responses` request re-sends the full running transcript in `input[]`,
 * which accumulates every prior `function_call` / `custom_tool_call` and the
 * matching `function_call_output` / `custom_tool_call_output`. Because a HAR may
 * retain only the tail of a long agent session, this accumulated request
 * transcript is the most complete source of the tool-call history — far more
 * complete than the sparse per-turn response events. Calls are added (deduped by
 * `call_id`); outputs are recorded in `toolResponses` for later matching.
 *
 * Takes the request body already parsed by the caller (request bodies are never
 * SSE). Non-object values (including a literal `null`, or a plain-string
 * `input`) are ignored.
 */
export function extractResponsesApiFromRequestBody(
  json: unknown,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
  toolResponses: Map<string, string>,
): void {
  // The caller parses once; guard before property access so a stray non-object
  // request body (e.g. a literal `null`) can't throw and abort extraction for
  // the whole HAR.
  if (!json || typeof json !== "object") return;

  const input = (json as Record<string, unknown>).input;
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

/**
 * Extract Responses API tool calls *and* their outputs from captured WebSocket
 * frames.
 *
 * gpt-5.x via the Copilot CLI can carry the Responses API over a **WebSocket**
 * instead of HTTP (when `copilot_cli_websocket_responses` is enabled). In that
 * case the request/response payloads never appear in HTTP bodies — they live in
 * the HAR entry's `_webSocketMessages` frames. This function is the transport
 * unwrapper: it reads each text frame's JSON and hands it to the *same* semantic
 * extractors used for the HTTP path, so no format logic is duplicated.
 *
 *   - `send` frames (client→server) are `response.create` messages carrying the
 *     accumulated `input[]` transcript (calls + their `*_output` results) — the
 *     same shape as an HTTP request body → {@link extractResponsesApiFromRequestBody}.
 *   - `receive` frames (server→client) are individual streamed response events
 *     (e.g. `response.output_item.done`) — the same objects as SSE `data:`
 *     payloads → collected into a synthetic {@link ParsedBody} and passed to
 *     {@link extractResponsesApiToolCallsFromBody}.
 *
 * Only text frames (opcode 1) carry JSON; binary frames (opcode 2) and any
 * non-object / unparseable payload are skipped. A non-array `messages` (e.g.
 * `undefined` for an HTTP-only entry) is a no-op, so this is safe to call for
 * every entry.
 */
export function extractResponsesApiFromWebSocketMessages(
  messages: HarWebSocketMessage[] | undefined,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
  toolResponses: Map<string, string>,
): void {
  if (!Array.isArray(messages)) return;

  // Receive frames are individual streamed events (same shape as SSE `data:`
  // payloads); collect them so the response extractor can consume them as one
  // synthetic SSE body. Send frames are handled inline (each is a full request
  // transcript).
  const receiveEvents: unknown[] = [];

  for (const frame of messages) {
    if (!frame || typeof frame !== "object") continue;
    // Skip binary frames (opcode 2); only text frames (opcode 1) carry JSON.
    if (frame.opcode === 2) continue;
    const data = frame.data;
    if (typeof data !== "string" || !data) continue;

    const json = tryParseJson(data);
    if (!json || typeof json !== "object") continue;

    if (frame.type === "send") {
      // Client→server `response.create`: reuse the request-body extractor, which
      // reads the accumulated `input[]` transcript (calls + `*_output` results).
      extractResponsesApiFromRequestBody(json, timestamp, toolCalls, toolResponses);
    } else if (frame.type === "receive") {
      receiveEvents.push(json);
    }
  }

  if (receiveEvents.length > 0) {
    // Response events are the only place the terminal call (e.g. `task_complete`)
    // appears; feed them through the response extractor via a synthetic body.
    extractResponsesApiToolCallsFromBody(
      { json: null, sseEvents: receiveEvents },
      timestamp,
      toolCalls,
    );
  }
}
