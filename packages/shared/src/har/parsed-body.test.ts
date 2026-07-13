// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseBody, tryParseJson } from "./parsed-body.js";

describe("tryParseJson", () => {
  it("returns the parsed value for a JSON object", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(tryParseJson("not json {")).toBeNull();
  });

  it("returns null for a literal null body (no throw)", () => {
    expect(tryParseJson("null")).toBeNull();
  });

  it("passes through JSON primitives", () => {
    expect(tryParseJson("123")).toBe(123);
    expect(tryParseJson("true")).toBe(true);
    expect(tryParseJson('"str"')).toBe("str");
  });
});

describe("parseBody", () => {
  it("returns a single JSON document as json with no sseEvents", () => {
    const parsed = parseBody('{"output":[]}');
    expect(parsed.json).toEqual({ output: [] });
    expect(parsed.sseEvents).toEqual([]);
  });

  it("parses an SSE stream into sseEvents with json = null", () => {
    const body = [
      'data: {"type":"a"}',
      'data: {"type":"b"}',
      "data: [DONE]",
    ].join("\n");
    const parsed = parseBody(body);
    expect(parsed.json).toBeNull();
    expect(parsed.sseEvents).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("skips malformed SSE payloads and non-data lines without throwing", () => {
    const body = [
      "event: message",
      "data: {broken",
      'data: {"ok":true}',
      "",
    ].join("\n");
    const parsed = parseBody(body);
    expect(parsed.json).toBeNull();
    expect(parsed.sseEvents).toEqual([{ ok: true }]);
  });
});
