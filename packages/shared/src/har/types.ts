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
 * A single iteration's captured tool calls, labeled with the iteration number
 * it belongs to. The judge assembles an ordered list of these (iterations
 * 1..N) so a criterion can be evaluated against the tool-call history of the
 * *whole run*, not just the iteration currently being judged. This is what lets
 * one-time actions (bootstrap/scaffold commands recorded in an earlier
 * iteration) keep counting as done in later iterations. See scope #1255.
 */
export interface IterationToolCalls {
  /** 1-based iteration number this batch of tool calls was captured in. */
  iteration: number;
  /** The tool calls captured during that iteration. */
  toolCalls: ToolCall[];
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
