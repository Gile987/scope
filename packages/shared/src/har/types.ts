// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Tool call extracted from a HAR file.
 * Represents a single tool invocation captured during a coding agent session.
 */
export interface ToolCall {
  /** Tool call ID (from the LLM response) */
  id: string;
  /** Tool/function name */
  name: string;
  /** Tool arguments (parsed JSON) */
  arguments: Record<string, unknown>;
  /** Tool response content (matched by tool_call_id) */
  response?: string;
  /** ISO timestamp of the HTTP request */
  timestamp?: string;
}

/**
 * Minimal HAR 1.2 types — just enough for parsing DevProxy output.
 * For full HAR types, use @types/har-format.
 */

export interface HarFile {
  log: HarLog;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

export interface HarEntry {
  startedDateTime: string;
  request: HarRequest;
  response: HarResponse;
  time: number;
  /**
   * Chrome DevTools resource type. Set to `"websocket"` by the gateway for a
   * WebSocket connection entry (the `/responses` transport used by gpt-5.x).
   */
  _resourceType?: string;
  /**
   * WebSocket frames captured for a WebSocket connection entry (gateway
   * convention). Present only when the entry carries a WebSocket connection;
   * absent for the HTTP entries produced by DevProxy.
   */
  _webSocketMessages?: HarWebSocketMessage[];
}

/**
 * A single captured WebSocket frame (Chrome DevTools / gateway HAR convention).
 *
 * For the OpenAI Responses API over WebSocket, `send` frames carry the client's
 * `response.create` messages (with the accumulated `input[]` transcript) and
 * `receive` frames carry the server's streamed response events (the same objects
 * as SSE `data:` payloads).
 */
export interface HarWebSocketMessage {
  /** Frame direction: `"send"` (client→server) or `"receive"` (server→client). */
  type: "send" | "receive";
  /** Fractional seconds since the Unix epoch when the frame was observed. */
  time: number;
  /** WebSocket opcode: 1 = text (JSON payload), 2 = binary. */
  opcode: number;
  /** Frame payload. For text frames (opcode 1) this is the JSON string. */
  data: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  headersSize: number;
  bodySize: number;
  postData?: {
    mimeType: string;
    text?: string;
    params?: HarNameValue[];
  };
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarNameValue[];
  content: {
    size: number;
    compression?: number;
    mimeType: string;
    text?: string;
    encoding?: string;
  };
  headersSize: number;
  bodySize: number;
  redirectURL: string;
}

export interface HarNameValue {
  name: string;
  value: string;
}
