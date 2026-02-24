// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseHarFile, extractToolCalls, sanitizeHar } from "./har-parser.js";
import type { HarFile, ToolCall } from "./types.js";

// Mock fs/promises for parseHarFile tests
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
const mockReadFile = vi.mocked(readFile);

/**
 * Helper to build a minimal HAR file structure.
 */
function makeHar(entries: HarFile["log"]["entries"]): HarFile {
  return {
    log: {
      version: "1.2",
      creator: { name: "DevProxy", version: "0.26.0" },
      entries,
    },
  };
}

/**
 * Helper to build a HAR entry with a JSON request/response body.
 */
function makeEntry(opts: {
  url?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseEncoding?: string;
  timestamp?: string;
}): HarFile["log"]["entries"][0] {
  const responseText = opts.responseBody
    ? typeof opts.responseBody === "string"
      ? opts.responseBody
      : JSON.stringify(opts.responseBody)
    : undefined;

  return {
    startedDateTime: opts.timestamp || "2025-01-15T10:00:00.000Z",
    time: 100,
    request: {
      method: "POST",
      url: opts.url || "https://api.githubcopilot.com/chat/completions",
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...(opts.requestBody
        ? {
            postData: {
              mimeType: "application/json",
              text: JSON.stringify(opts.requestBody),
            },
          }
        : {}),
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: {
        size: responseText?.length || 0,
        mimeType: "application/json",
        text: responseText,
        encoding: opts.responseEncoding,
      },
      headersSize: -1,
      bodySize: -1,
      redirectURL: "",
    },
  };
}

describe("parseHarFile", () => {
  it("reads and parses a HAR file from disk", async () => {
    const har = makeHar([]);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(har));

    const result = await parseHarFile("/tmp/test.har");

    expect(mockReadFile).toHaveBeenCalledWith("/tmp/test.har", "utf-8");
    expect(result).toEqual(har);
  });

  it("throws on invalid JSON", async () => {
    mockReadFile.mockResolvedValueOnce("not-json");

    await expect(parseHarFile("/tmp/bad.har")).rejects.toThrow();
  });
});

describe("extractToolCalls", () => {
  describe("non-streaming responses", () => {
    it("extracts tool calls from a standard chat completion response", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_001",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"src/index.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        id: "call_001",
        name: "read_file",
        arguments: { path: "src/index.ts" },
        timestamp: "2025-01-15T10:00:00.000Z",
      });
    });

    it("extracts multiple tool calls from a single response", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_a",
                      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                    },
                    {
                      id: "call_b",
                      function: { name: "write_file", arguments: '{"path":"b.ts","content":"hello"}' },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);

      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe("read_file");
      expect(calls[1].name).toBe("write_file");
    });

    it("deduplicates tool calls by id", () => {
      const responseBody = {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                { id: "call_dup", function: { name: "read_file", arguments: '{}' } },
              ],
            },
          },
        ],
      };

      const har = makeHar([
        makeEntry({ responseBody }),
        makeEntry({ responseBody }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
    });

    it("handles unparseable arguments as _raw", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_x", function: { name: "broken", arguments: "not-json{" } },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toEqual({ _raw: "not-json{" });
    });
  });

  describe("streaming responses (SSE)", () => {
    it("accumulates tool calls from SSE data chunks", () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_sse","function":{"name":"list_files","arguments":"{\\"dir\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"src\\"}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([
        makeEntry({ responseBody: sseBody }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("list_files");
      expect(calls[0].arguments).toEqual({ dir: "src" });
    });

    it("skips malformed SSE lines", () => {
      const sseBody = [
        "data: not-json",
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_ok","function":{"name":"foo","arguments":"{}"}}]}}]}',
        "data: [DONE]",
      ].join("\n");

      const har = makeHar([makeEntry({ responseBody: sseBody })]);
      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("foo");
    });
  });

  describe("tool responses", () => {
    it("matches tool role messages to tool calls by tool_call_id", () => {
      const har = makeHar([
        // First entry: response with tool_calls
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_123", function: { name: "read_file", arguments: '{"path":"x.ts"}' } },
                  ],
                },
              },
            ],
          },
        }),
        // Second entry: request with tool role message
        makeEntry({
          requestBody: {
            messages: [
              { role: "tool", tool_call_id: "call_123", content: "file contents here" },
            ],
          },
          responseBody: { choices: [] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].response).toBe("file contents here");
    });

    it("handles tool responses with object content", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_obj", function: { name: "api_call", arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        }),
        makeEntry({
          requestBody: {
            messages: [
              { role: "tool", tool_call_id: "call_obj", content: { result: "ok" } },
            ],
          },
          responseBody: { choices: [] },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls[0].response).toBe('{"result":"ok"}');
    });

    it("leaves response undefined when no matching tool message exists", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "call_orphan", function: { name: "orphan", arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        }),
      ]);

      const calls = extractToolCalls(har);
      expect(calls[0].response).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns empty array for HAR with no entries", () => {
      const har = makeHar([]);
      expect(extractToolCalls(har)).toEqual([]);
    });

    it("returns empty array for entries with no tool calls", () => {
      const har = makeHar([
        makeEntry({
          responseBody: {
            choices: [
              { message: { role: "assistant", content: "Hello!" } },
            ],
          },
        }),
      ]);
      expect(extractToolCalls(har)).toEqual([]);
    });

    it("handles base64-encoded response content", () => {
      const responseJson = JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call_b64", function: { name: "b64_tool", arguments: '{}' } },
              ],
            },
          },
        ],
      });
      const b64 = Buffer.from(responseJson).toString("base64");

      const har = makeHar([
        makeEntry({
          responseBody: b64,
          responseEncoding: "base64",
        }),
      ]);

      // The entry needs the raw base64 text with encoding set
      // Override the entry to set encoding properly
      har.log.entries[0].response.content.text = b64;
      har.log.entries[0].response.content.encoding = "base64";

      const calls = extractToolCalls(har);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("b64_tool");
    });

    it("handles entries with no response body", () => {
      const har = makeHar([
        makeEntry({}),
      ]);
      har.log.entries[0].response.content.text = undefined;

      expect(extractToolCalls(har)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// sanitizeHar
// ---------------------------------------------------------------------------

/** Helper to build a HAR entry with explicit headers. */
function makeEntryWithHeaders(opts: {
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
}): HarFile["log"]["entries"][0] {
  const base = makeEntry({});
  return {
    ...base,
    request: {
      ...base.request,
      headers: opts.requestHeaders ?? [],
    },
    response: {
      ...base.response,
      headers: opts.responseHeaders ?? [],
    },
  };
}

describe("sanitizeHar", () => {
  it("redacts Authorization header", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "Authorization", value: "Bearer ghp_secret123" },
          { name: "Content-Type", value: "application/json" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);

    expect(sanitized.log.entries[0].request.headers).toEqual([
      { name: "Authorization", value: "[REDACTED]" },
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("redacts headers case-insensitively", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "authorization", value: "Bearer token" },
          { name: "AUTHORIZATION", value: "Bearer TOKEN" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);

    for (const h of sanitized.log.entries[0].request.headers) {
      expect(h.value).toBe("[REDACTED]");
    }
  });

  it("redacts X-GitHub-Token header", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "X-GitHub-Token", value: "ghu_token456" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
  });

  it("redacts api-key and X-Api-Key headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "api-key", value: "sk-12345" },
          { name: "X-Api-Key", value: "key-67890" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers).toEqual([
      { name: "api-key", value: "[REDACTED]" },
      { name: "X-Api-Key", value: "[REDACTED]" },
    ]);
  });

  it("redacts response OAuth scope headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        responseHeaders: [
          { name: "X-OAuth-Scopes", value: "repo, user" },
          { name: "X-Accepted-OAuth-Scopes", value: "repo" },
          { name: "X-RateLimit-Remaining", value: "42" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].response.headers).toEqual([
      { name: "X-OAuth-Scopes", value: "[REDACTED]" },
      { name: "X-Accepted-OAuth-Scopes", value: "[REDACTED]" },
      { name: "X-RateLimit-Remaining", value: "42" },
    ]);
  });

  it("redacts Cookie and Set-Cookie headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Cookie", value: "session=abc" }],
        responseHeaders: [{ name: "Set-Cookie", value: "session=xyz; path=/" }],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
    expect(sanitized.log.entries[0].response.headers[0].value).toBe("[REDACTED]");
  });

  it("does not mutate the original HAR object", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer secret" }],
      }),
    ]);

    const originalValue = har.log.entries[0].request.headers[0].value;
    sanitizeHar(har);
    expect(har.log.entries[0].request.headers[0].value).toBe(originalValue);
  });

  it("preserves non-sensitive headers", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Accept", value: "*/*" },
          { name: "User-Agent", value: "test/1.0" },
        ],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries[0].request.headers).toEqual(
      har.log.entries[0].request.headers,
    );
  });

  it("handles HAR with no entries", () => {
    const har = makeHar([]);
    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries).toEqual([]);
  });

  it("sanitizes multiple entries independently", () => {
    const har = makeHar([
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer token1" }],
      }),
      makeEntryWithHeaders({
        requestHeaders: [{ name: "Authorization", value: "Bearer token2" }],
      }),
    ]);

    const sanitized = sanitizeHar(har);
    expect(sanitized.log.entries).toHaveLength(2);
    expect(sanitized.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
    expect(sanitized.log.entries[1].request.headers[0].value).toBe("[REDACTED]");
  });
});
