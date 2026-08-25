// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  buildChatCompletionRequestBody,
  isReasoningChatModel,
} from "./chat-completions.js";

const messages = [{ role: "user" as const, content: "ping" }];

describe("chat completion request bodies", () => {
  it.each(["gpt-5", "gpt-5.4-mini", "o1", "o4-mini"])(
    "uses reasoning-model parameters for %s",
    (model) => {
      expect(isReasoningChatModel(model)).toBe(true);
      expect(
        buildChatCompletionRequestBody({
          messages,
          model,
          maxTokens: 512,
          temperature: 0.3,
        }),
      ).toEqual({
        messages,
        model,
        max_completion_tokens: 512,
      });
    },
  );

  it("uses max_completion_tokens while retaining sampling for non-reasoning models", () => {
    expect(
      buildChatCompletionRequestBody({
        messages,
        model: "gpt-4.1",
        maxTokens: 512,
        temperature: 0.3,
      }),
    ).toEqual({
      messages,
      model: "gpt-4.1",
      max_completion_tokens: 512,
      temperature: 0.3,
    });
  });
});
