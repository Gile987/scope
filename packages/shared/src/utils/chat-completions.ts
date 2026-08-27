// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const CHAT_COMPLETION_REQUEST_PROFILES = ["legacy", "reasoning"] as const;
export type ChatCompletionRequestProfile =
  (typeof CHAT_COMPLETION_REQUEST_PROFILES)[number];

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
 * Suggest a request profile from a deployment/model name. This is only a
 * registration default and a compatibility fallback for credentials created
 * before request profiles were persisted; explicit configuration wins.
 */
export function inferChatCompletionRequestProfile(
  model: string,
): ChatCompletionRequestProfile {
  return /^(?:gpt-5|o[1-9])(?:[.-]|$)/i.test(model.trim())
    ? "reasoning"
    : "legacy";
}

export function parseChatCompletionRequestProfile(
  value: unknown,
): ChatCompletionRequestProfile | undefined {
  return typeof value === "string" &&
    CHAT_COMPLETION_REQUEST_PROFILES.includes(
      value as ChatCompletionRequestProfile,
    )
    ? (value as ChatCompletionRequestProfile)
    : undefined;
}

export function resolveChatCompletionRequestProfile(
  profile: ChatCompletionRequestProfile | undefined,
  model: string,
): ChatCompletionRequestProfile {
  return profile ?? inferChatCompletionRequestProfile(model);
}

export function buildChatCompletionRequestBody(options: {
  messages: ChatCompletionMessage[];
  model: string;
  maxTokens: number;
  temperature?: number;
  requestProfile: ChatCompletionRequestProfile;
}): ChatCompletionRequestBody {
  const { messages, model, maxTokens, temperature, requestProfile } = options;
  if (requestProfile === "reasoning") {
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
