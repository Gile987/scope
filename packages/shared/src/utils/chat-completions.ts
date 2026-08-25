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

export type ChatCompletionRequestBody = ChatCompletionRequestBase & {
  max_completion_tokens: number;
  temperature?: number;
};

/**
 * Chat Completions uses max_completion_tokens across current Azure OpenAI
 * deployments. GPT-5 and o-series reasoning models additionally reject
 * sampling controls such as temperature.
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
    max_completion_tokens: maxTokens,
    ...(temperature === undefined ? {} : { temperature }),
  };
}
