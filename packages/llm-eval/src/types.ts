// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Transport abstractions for the eval harness.
 *
 * `llm-eval` is deliberately transport-agnostic: callers inject a `ChatComplete`
 * (an adapter around GitHub Models / Azure inference / the token-manager / a fake)
 * so the grader and sampling harness never depend on a specific SDK or credential
 * path. This keeps the package free of `@azure-rest/ai-inference` and app-level
 * token plumbing, and makes the grader trivially unit-testable with a fake.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompleteRequest {
  messages: ChatMessage[];
  /** Model id; when omitted the adapter should fall back to its own default. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** A single chat-completion call: messages in, assistant text out. */
export type ChatComplete = (request: ChatCompleteRequest) => Promise<string>;
