// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared test helpers for the HAR parser test suites
 * (`har-parser.test.ts`, `responses-api-parser.test.ts`).
 */
import type { HarFile, HarWebSocketMessage } from "./types.js";

/**
 * Helper to build a minimal HAR file structure.
 */
export function makeHar(entries: HarFile["log"]["entries"]): HarFile {
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
export function makeEntry(opts: {
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

/**
 * Build a WebSocket HAR entry (gateway convention): a `GET` + `101` upgrade with
 * `_resourceType: "websocket"`, no HTTP body, and the captured frames in
 * `_webSocketMessages`. Mirrors the real gateway envelope so the WebSocket
 * transport path in `extractToolCalls` can be exercised.
 *
 * Frame `opcode` defaults to 1 (text) and `time` to 0 when omitted; pass
 * `opcode: 2` to simulate a binary frame.
 */
export function makeWsEntry(opts: {
  url?: string;
  messages: Array<{ type: "send" | "receive"; data: string; opcode?: number; time?: number }>;
  timestamp?: string;
}): HarFile["log"]["entries"][0] {
  const messages: HarWebSocketMessage[] = opts.messages.map((m) => ({
    type: m.type,
    opcode: m.opcode ?? 1,
    time: m.time ?? 0,
    data: m.data,
  }));

  return {
    startedDateTime: opts.timestamp || "2025-01-15T10:00:00.000Z",
    time: 100,
    _resourceType: "websocket",
    request: {
      method: "GET",
      url: opts.url || "wss://api.enterprise.githubcopilot.com/responses",
      httpVersion: "HTTP/1.1",
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 101,
      statusText: "Switching Protocols",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 0, mimeType: "x-unknown" },
      headersSize: -1,
      bodySize: 0,
      redirectURL: "",
    },
    _webSocketMessages: messages,
  };
}
