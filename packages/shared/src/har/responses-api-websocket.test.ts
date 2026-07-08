// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { extractToolCalls } from "./har-parser.js";
import { extractResponsesApiFromWebSocketMessages } from "./responses-api-parser.js";
import { makeHar, makeWsEntry } from "./test-helpers.js";
import type { ToolCall } from "./types.js";

/**
 * WebSocket transport for the OpenAI Responses API (#1253).
 *
 * gpt-5.x via the Copilot CLI can carry `/responses` over a WebSocket, so the
 * tool-call payloads live in the HAR entry's `_webSocketMessages` frames rather
 * than HTTP bodies. `extractToolCalls` must unwrap those frames and reuse the
 * existing Responses-API semantic extractors.
 */
describe("extractToolCalls (Responses API over WebSocket)", () => {
  // Build a WebSocket frame from an event object; `data` is the JSON string that
  // rides the wire (mirrors the real gateway envelope where `arguments` is
  // itself a JSON string).
  const send = (obj: unknown) => ({ type: "send" as const, data: JSON.stringify(obj) });
  const recv = (obj: unknown) => ({ type: "receive" as const, data: JSON.stringify(obj) });

  describe("receive frames (server → client streamed events)", () => {
    it("extracts a function_call from a receive `output_item.done` frame", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              recv({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "bash" } }),
              recv({
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  name: "bash",
                  call_id: "call_1",
                  id: "opaque_encrypted_id_ignore_me",
                  arguments: JSON.stringify({ command: "npm run build", description: "build" }),
                  status: "completed",
                },
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      // Keyed by call_id, NOT the opaque `id`.
      expect(calls[0]).toMatchObject({
        id: "call_1",
        name: "bash",
        arguments: { command: "npm run build", description: "build" },
      });
    });

    it("extracts a custom_tool_call from a receive frame, preserving raw input under _raw", () => {
      const patch = "*** Begin Patch\n*** Add File: a.ts\n+export const x = 1;\n*** End Patch";
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              recv({
                type: "response.output_item.done",
                item: { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: patch },
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_2", name: "apply_patch", arguments: { _raw: patch } });
    });

    it("captures a response-only terminal call (e.g. task_complete) present only in receive frames", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              recv({
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  name: "task_complete",
                  call_id: "call_final",
                  arguments: JSON.stringify({ summary: "done" }),
                },
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_final", name: "task_complete", arguments: { summary: "done" } });
      // A terminal call has no result echoed back in a later transcript.
      expect(calls[0].response).toBeUndefined();
    });
  });

  describe("send frames (client → server `response.create` transcript)", () => {
    it("extracts calls from `input[]` and matches their `*_output` results", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              send({
                type: "response.create",
                model: "gpt-5.5",
                input: [
                  { role: "user", content: [{ type: "input_text", text: "run the build" }] },
                  { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "npm run build" }) },
                  { type: "function_call_output", call_id: "call_1", output: "build succeeded" },
                ],
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        id: "call_1",
        name: "bash",
        arguments: { command: "npm run build" },
        response: "build succeeded",
      });
    });

    it("matches a custom_tool_call_output to its custom_tool_call", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              send({
                type: "response.create",
                input: [
                  { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "*** Begin Patch" },
                  { type: "custom_tool_call_output", call_id: "call_2", output: "patch applied" },
                ],
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_2", name: "apply_patch", response: "patch applied" });
    });
  });

  describe("dedup across send + receive frames", () => {
    it("does not duplicate a call that appears in both a receive `done` and a send transcript", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              // First: the streamed response emits the call.
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "ls" }) },
              }),
              // Later: the next request echoes it back with its result.
              send({
                type: "response.create",
                input: [
                  { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "ls" }) },
                  { type: "function_call_output", call_id: "call_1", output: "a.ts b.ts" },
                ],
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_1", name: "bash", response: "a.ts b.ts" });
    });

    it("dedupes across separate WebSocket entries sharing a call_id", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "view", call_id: "call_9", arguments: JSON.stringify({ path: "/a.ts" }) },
              }),
            ],
          }),
          makeWsEntry({
            messages: [
              send({
                type: "response.create",
                input: [
                  { type: "function_call", name: "view", call_id: "call_9", arguments: JSON.stringify({ path: "/a.ts" }) },
                  { type: "function_call_output", call_id: "call_9", output: "file contents" },
                ],
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_9", name: "view", response: "file contents" });
    });
  });

  describe("malformed / non-text / non-array frames are ignored without throwing", () => {
    it("skips binary frames (opcode 2) but still parses text frames", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              // Binary frame with a base64-ish payload — must be skipped, not parsed.
              { type: "receive", opcode: 2, data: "AAECAwQF" },
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "ls" }) },
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_1", name: "bash" });
    });

    it("skips frames whose `data` is not valid JSON", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              { type: "receive", data: "not json {{{" },
              { type: "send", data: "<<< garbage" },
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "ls" }) },
              }),
            ],
          }),
        ]),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_1", name: "bash" });
    });

    it("does not throw for non-array `_webSocketMessages`", () => {
      const toolCalls = new Map<string, ToolCall>();
      const toolResponses = new Map<string, string>();
      for (const bad of [undefined, null, {}, 42, "frames"] as unknown[]) {
        expect(() =>
          extractResponsesApiFromWebSocketMessages(
            bad as never,
            "2025-01-15T10:00:00.000Z",
            toolCalls,
            toolResponses,
          ),
        ).not.toThrow();
      }
      expect(toolCalls.size).toBe(0);
      expect(toolResponses.size).toBe(0);
    });
  });

  describe("end-to-end: WebSocket-only HAR yields a non-empty, matched history", () => {
    it("extracts a full multi-tool interaction over a single WebSocket connection", () => {
      const calls = extractToolCalls(
        makeHar([
          makeWsEntry({
            messages: [
              // Turn 1: request establishes the task.
              send({ type: "response.create", model: "gpt-5.5", input: [{ role: "user", content: [{ type: "input_text", text: "build and test" }] }] }),
              // Turn 1 response: model asks to run the build.
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "npm run build" }) },
              }),
              // Turn 2 request: echoes call_1 + its result, model asks to patch a file.
              send({
                type: "response.create",
                input: [
                  { type: "function_call", name: "bash", call_id: "call_1", arguments: JSON.stringify({ command: "npm run build" }) },
                  { type: "function_call_output", call_id: "call_1", output: "build ok" },
                ],
              }),
              recv({
                type: "response.output_item.done",
                item: { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "*** Begin Patch" },
              }),
              // Turn 3 request: echoes call_2 + its result.
              send({
                type: "response.create",
                input: [
                  { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "*** Begin Patch" },
                  { type: "custom_tool_call_output", call_id: "call_2", output: "patched" },
                ],
              }),
              // Terminal call — appears only in the response.
              recv({
                type: "response.output_item.done",
                item: { type: "function_call", name: "task_complete", call_id: "call_3", arguments: JSON.stringify({ summary: "done" }) },
              }),
            ],
          }),
        ]),
      );

      expect(calls.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(3);
      const byId = Object.fromEntries(calls.map((c) => [c.id, c]));
      expect(byId["call_1"]).toMatchObject({ name: "bash", response: "build ok" });
      expect(byId["call_2"]).toMatchObject({ name: "apply_patch", response: "patched" });
      expect(byId["call_3"]).toMatchObject({ name: "task_complete" });
      expect(byId["call_3"].response).toBeUndefined();
    });
  });

  it("is a no-op for an HTTP-only HAR (no `_webSocketMessages`)", () => {
    // A WebSocket entry with an empty frame list contributes nothing and must
    // not interfere with extraction.
    const calls = extractToolCalls(makeHar([makeWsEntry({ messages: [] })]));
    expect(calls).toHaveLength(0);
  });
});
