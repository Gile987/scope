// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * HAR file parser and tool call extractor.
 *
 * Parses HAR (HTTP Archive) files produced by DevProxy and extracts
 * structured tool call data from Copilot API request/response bodies.
 *
 * The extraction logic mirrors SCOPE's packages/coder/utils/har.ts:
 * - Scans response bodies for assistant role messages containing tool_calls arrays
 * - Matches tool role messages by tool_call_id to attach responses
 * - Produces an array of ToolCall objects
 */

import { readFile, writeFile } from "node:fs/promises";
import type { HarFile, HarEntry, HarNameValue, ToolCall } from "./types.js";

/**
 * Header names whose values must be redacted before HAR files are
 * persisted or served to clients.  Matching is case-insensitive.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-github-token",
  "x-api-key",
  "api-key",
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
  "cookie",
  "set-cookie",
]);

const REDACTED = "[REDACTED]";

/**
 * Return a deep-copy of the HAR with sensitive header values replaced by
 * `[REDACTED]`.  The original object is never mutated.
 */
export function sanitizeHar(har: HarFile): HarFile {
  return {
    log: {
      ...har.log,
      entries: har.log.entries.map((entry) => ({
        ...entry,
        request: {
          ...entry.request,
          headers: redactHeaders(entry.request.headers),
        },
        response: {
          ...entry.response,
          headers: redactHeaders(entry.response.headers),
        },
      })),
    },
  };
}

function redactHeaders(headers: HarNameValue[]): HarNameValue[] {
  return headers.map((h) =>
    SENSITIVE_HEADERS.has(h.name.toLowerCase())
      ? { name: h.name, value: REDACTED }
      : h,
  );
}

/**
 * Read a HAR file, sanitize it, write it to `outPath`, and return
 * the sanitised HAR object.
 */
export async function sanitizeHarFile(
  inPath: string,
  outPath: string,
): Promise<HarFile> {
  const har = await parseHarFile(inPath);
  const sanitized = sanitizeHar(har);
  await writeFile(outPath, JSON.stringify(sanitized), "utf-8");
  return sanitized;
}

/**
 * Parse a HAR file from disk.
 */
export async function parseHarFile(filePath: string): Promise<HarFile> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as HarFile;
}

/**
 * Extract tool calls from a parsed HAR file.
 *
 * Scans HTTP request/response bodies for OpenAI-style chat completions
 * containing tool_calls in assistant messages and tool role responses.
 */
export function extractToolCalls(har: HarFile): ToolCall[] {
  const toolCalls: Map<string, ToolCall> = new Map();
  const toolResponses: Map<string, string> = new Map();

  for (const entry of har.log.entries) {
    // Process response bodies for assistant messages with tool_calls
    const responseBody = getResponseBody(entry);
    if (responseBody) {
      extractToolCallsFromBody(responseBody, entry.startedDateTime, toolCalls);
    }

    // Process request bodies for tool role messages (responses to tool calls)
    const requestBody = getRequestBody(entry);
    if (requestBody) {
      extractToolResponsesFromBody(requestBody, toolResponses);
    }
  }

  // Match tool responses to their originating tool calls
  for (const [id, response] of toolResponses) {
    const toolCall = toolCalls.get(id);
    if (toolCall) {
      toolCall.response = response;
    }
  }

  return Array.from(toolCalls.values());
}

/**
 * Get the response body text from a HAR entry, handling base64 encoding.
 */
function getResponseBody(entry: HarEntry): string | null {
  const content = entry.response?.content;
  if (!content?.text) return null;

  if (content.encoding === "base64") {
    try {
      // Use globalThis.atob for browser+Node 16+ compatibility
      // (avoids Node-only Buffer dependency)
      return decodeURIComponent(
        Array.from(globalThis.atob(content.text), (c) =>
          "%" + c.charCodeAt(0).toString(16).padStart(2, "0")
        ).join("")
      );
    } catch {
      return null;
    }
  }
  return content.text;
}

/**
 * Get the request body text from a HAR entry.
 */
function getRequestBody(entry: HarEntry): string | null {
  return entry.request?.postData?.text ?? null;
}

/**
 * Extract tool_calls from response body.
 *
 * Handles both streaming (SSE) and non-streaming responses:
 * - Non-streaming: JSON with choices[].message.tool_calls
 * - Streaming: multiple `data: {...}` lines with choices[].delta.tool_calls
 */
function extractToolCallsFromBody(
  body: string,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  // Try non-streaming format first
  try {
    const json = JSON.parse(body);
    processChoices(json, timestamp, toolCalls);
    return;
  } catch {
    // Not a single JSON object — try streaming
  }

  // Handle SSE streaming format (data: {...}\n)
  const lines = body.split("\n");
  // Accumulate partial tool call data for streaming
  const partialCalls: Map<string, { name: string; arguments: string }> = new Map();
  // Map SSE index → tool call id so continuation chunks (which only
  // carry `index`, not `id`) can find the right partial entry.
  const indexToId: Map<number, string> = new Map();
  // Auto-incrementing counter for initial chunks that lack an explicit index.
  let nextAutoIndex = 0;

  for (const line of lines) {
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
            // New tool call chunk with id — register both maps
            partialCalls.set(tc.id, {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
            // Use the explicit index if provided, otherwise assign
            // the next auto-index so continuation chunks can match.
            const idx = tc.index ?? nextAutoIndex;
            indexToId.set(idx, tc.id);
            nextAutoIndex = idx + 1;
          } else if (tc.index !== undefined) {
            // Continuation chunk — look up by SSE index
            const id = indexToId.get(tc.index);
            if (id) {
              const partial = partialCalls.get(id);
              if (partial && tc.function?.arguments) {
                partial.arguments += tc.function.arguments;
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Convert accumulated partial calls to ToolCall objects
  for (const [id, partial] of partialCalls) {
    if (!toolCalls.has(id)) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(partial.arguments);
      } catch {
        parsedArgs = { _raw: partial.arguments };
      }

      toolCalls.set(id, {
        id,
        name: partial.name,
        arguments: parsedArgs,
        timestamp,
      });
    }
  }
}

/**
 * Process choices array from a non-streaming response.
 */
function processChoices(
  json: Record<string, unknown>,
  timestamp: string,
  toolCalls: Map<string, ToolCall>,
): void {
  const choices = json.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!message) continue;

    const tcArray = message.tool_calls;
    if (!Array.isArray(tcArray)) continue;

    for (const tc of tcArray) {
      const tcObj = tc as Record<string, unknown>;
      const id = tcObj.id as string;
      if (!id || toolCalls.has(id)) continue;

      const fn = tcObj.function as Record<string, unknown> | undefined;
      let parsedArgs: Record<string, unknown> = {};
      if (fn?.arguments) {
        try {
          parsedArgs = JSON.parse(fn.arguments as string);
        } catch {
          parsedArgs = { _raw: fn.arguments as string };
        }
      }

      toolCalls.set(id, {
        id,
        name: (fn?.name as string) || "unknown",
        arguments: parsedArgs,
        timestamp,
      });
    }
  }
}

/**
 * Extract tool role messages from request bodies.
 * These contain the responses to tool calls, matched by tool_call_id.
 */
function extractToolResponsesFromBody(
  body: string,
  toolResponses: Map<string, string>,
): void {
  try {
    const json = JSON.parse(body);
    const messages = json.messages;
    if (!Array.isArray(messages)) return;

    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id && msg.content) {
        const content = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
        toolResponses.set(msg.tool_call_id, content);
      }
    }
  } catch {
    // Not a valid JSON body — skip
  }
}

/**
 * Extract thinking/reasoning content from a parsed HAR file.
 *
 * Scans SSE streaming responses for `reasoning_text` fields in
 * `choices[].delta` and concatenates them into a single string.
 * These fields contain the model's chain-of-thought reasoning
 * (e.g. Copilot extended thinking).
 */
export function extractThinkingContent(har: HarFile): string {
  const parts: string[] = [];

  for (const entry of har.log.entries) {
    const body = getResponseBody(entry);
    if (!body) continue;

    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const choices = json.choices;
        if (!Array.isArray(choices)) continue;

        for (const choice of choices) {
          const delta = choice.delta;
          if (!delta) continue;

          // OpenAI-style reasoning_text field (used by Copilot)
          if (typeof delta.reasoning_text === "string" && delta.reasoning_text) {
            parts.push(delta.reasoning_text);
          }
          // Also check for 'thinking' field (Anthropic-style, via proxy)
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
