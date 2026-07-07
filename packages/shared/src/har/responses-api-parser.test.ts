// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { extractToolCalls } from "./har-parser.js";
import { makeHar, makeEntry } from "./test-helpers.js";

describe("extractToolCalls (Responses API / gpt-5.x)", () => {
  const RESP_URL = "https://api.enterprise.githubcopilot.com/responses";
  // Build one SSE `data:` line from an event object (mirrors the real wire
  // format where `arguments` is itself a JSON string).
  const sseData = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

  describe("response side (output_item.done / output[])", () => {
    it("extracts a function_call from a response.output_item.done SSE event", () => {
      const sse = [
        sseData({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "bash" } }),
        sseData({
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
        "data: [DONE]",
      ].join("\n");

      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, responseBody: sse })]));
      expect(calls).toHaveLength(1);
      // Keyed by call_id, NOT the opaque `id`.
      expect(calls[0]).toMatchObject({
        id: "call_1",
        name: "bash",
        arguments: { command: "npm run build", description: "build" },
      });
    });

    it("extracts a custom_tool_call, preserving raw input under _raw", () => {
      const patch = "*** Begin Patch\n*** Add File: a.ts\n+export const x = 1;\n*** End Patch";
      const sse = [
        sseData({
          type: "response.output_item.done",
          item: { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: patch },
        }),
        "data: [DONE]",
      ].join("\n");

      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, responseBody: sse })]));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_2", name: "apply_patch", arguments: { _raw: patch } });
    });

    it("extracts function_call items from a non-streaming output[] response", () => {
      const body = {
        output: [
          { type: "message", role: "assistant", content: [] },
          { type: "function_call", name: "view", call_id: "call_9", arguments: JSON.stringify({ path: "/a.ts" }) },
        ],
      };
      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, responseBody: body })]));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ id: "call_9", name: "view", arguments: { path: "/a.ts" } });
    });

    it("ignores non-tool output_item.done items (message/reasoning)", () => {
      const sse = [
        sseData({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [] } }),
        sseData({ type: "response.output_item.done", item: { type: "reasoning", id: "r1" } }),
        "data: [DONE]",
      ].join("\n");
      expect(extractToolCalls(makeHar([makeEntry({ url: RESP_URL, responseBody: sse })]))).toHaveLength(0);
    });

    it("falls back to _raw for unparseable function_call arguments", () => {
      const sse = [
        sseData({ type: "response.output_item.done", item: { type: "function_call", name: "bash", call_id: "call_x", arguments: "not json {" } }),
        "data: [DONE]",
      ].join("\n");
      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, responseBody: sse })]));
      expect(calls[0].arguments).toEqual({ _raw: "not json {" });
    });
  });

  describe("request side (input[] transcript + outputs)", () => {
    it("extracts calls and matches outputs from the request input[] transcript", () => {
      const requestBody = {
        model: "gpt-5",
        input: [
          { type: "function_call", name: "view", call_id: "call_3", arguments: JSON.stringify({ path: "/a.ts" }) },
          { type: "function_call_output", call_id: "call_3", output: "file contents" },
          { type: "custom_tool_call", name: "apply_patch", call_id: "call_4", input: "*** Begin Patch" },
          { type: "custom_tool_call_output", call_id: "call_4", output: "Added 1 file(s)" },
        ],
      };
      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, requestBody })]));
      expect(calls).toHaveLength(2);
      const byId = Object.fromEntries(calls.map((c) => [c.id, c]));
      expect(byId["call_3"]).toMatchObject({ name: "view", arguments: { path: "/a.ts" }, response: "file contents" });
      expect(byId["call_4"]).toMatchObject({ name: "apply_patch", arguments: { _raw: "*** Begin Patch" }, response: "Added 1 file(s)" });
    });

    it("ignores a string-valued input (simple prompt) without throwing", () => {
      const har = makeHar([makeEntry({ url: RESP_URL, requestBody: { input: "just a prompt" } })]);
      expect(extractToolCalls(har)).toHaveLength(0);
    });

    it("stringifies non-string output values", () => {
      const requestBody = {
        input: [
          { type: "function_call", name: "bash", call_id: "call_5", arguments: "{}" },
          { type: "function_call_output", call_id: "call_5", output: { ok: true } },
        ],
      };
      const calls = extractToolCalls(makeHar([makeEntry({ url: RESP_URL, requestBody })]));
      expect(calls[0].response).toBe(JSON.stringify({ ok: true }));
    });
  });

  describe("union of both sources", () => {
    it("captures response-only terminal calls, request-only history, and dedupes overlap", () => {
      // Entry 1: response emits the latest turn's calls — a bash call and the
      // terminal task_complete (which is never echoed into a later request).
      const entry1 = makeEntry({
        url: RESP_URL,
        responseBody: [
          sseData({ type: "response.output_item.done", item: { type: "function_call", name: "bash", call_id: "call_5", arguments: JSON.stringify({ command: "ls" }) } }),
          sseData({ type: "response.output_item.done", item: { type: "function_call", name: "task_complete", call_id: "call_6", arguments: "{}" } }),
          "data: [DONE]",
        ].join("\n"),
      });
      // Entry 2: request transcript carries the accumulated history — call_5
      // again (dedup) with its output, plus an earlier call_7 the response
      // bodies never captured (HAR retained only the tail).
      const entry2 = makeEntry({
        url: RESP_URL,
        requestBody: {
          input: [
            { type: "function_call", name: "view", call_id: "call_7", arguments: JSON.stringify({ path: "/b.ts" }) },
            { type: "function_call_output", call_id: "call_7", output: "b contents" },
            { type: "function_call", name: "bash", call_id: "call_5", arguments: JSON.stringify({ command: "ls" }) },
            { type: "function_call_output", call_id: "call_5", output: "<shellId: 0 completed with exit code 0>" },
          ],
        },
      });

      const calls = extractToolCalls(makeHar([entry1, entry2]));
      const byId = Object.fromEntries(calls.map((c) => [c.id, c]));
      expect(Object.keys(byId).sort()).toEqual(["call_5", "call_6", "call_7"]);
      // Overlapping call_5 appears once, with its output matched.
      expect(byId["call_5"].response).toBe("<shellId: 0 completed with exit code 0>");
      // Terminal task_complete is response-only and has no output.
      expect(byId["call_6"]).toMatchObject({ name: "task_complete" });
      expect(byId["call_6"].response).toBeUndefined();
      // Request-only historical call is recovered with its output.
      expect(byId["call_7"]).toMatchObject({ name: "view", response: "b contents" });
    });
  });
});
