// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequestBase {
  messages: ChatCompletionMessage[];
  model: string;
}

export type ChatCompletionRequestBody =
  | (ChatCompletionRequestBase & {
      max_completion_tokens: number;
    })
  | (ChatCompletionRequestBase & {
      max_tokens: number;
      temperature?: number;
    });

/**
 * GPT-5 and o-series reasoning models use max_completion_tokens and reject
 * sampling controls such as temperature. Other models retain the legacy
 * max_tokens parameter and their configured sampling controls.
 */
export function isReasoningChatModel(model: string): boolean {
  return /^(?:gpt-5|o[1-9])(?:[.-]|$)/i.test(model.trim());
}

export function buildChatCompletionRequestBody(options: {
  messages: ChatCompletionMessage[];
  model: string;
  maxTokens: number;
  temperature?: number;
}): ChatCompletionRequestBody {
  const { messages, model, maxTokens, temperature } = options;
  if (isReasoningChatModel(model)) {
    return {
      messages,
      model,
      max_completion_tokens: maxTokens,
    };
  }

  return {
    messages,
    model,
    max_tokens: maxTokens,
    ...(temperature === undefined ? {} : { temperature }),
  };
}
