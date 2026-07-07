// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared test helpers for the HAR parser test suites
 * (`har-parser.test.ts`, `responses-api-parser.test.ts`).
 */
import type { HarFile } from "./types.js";

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
