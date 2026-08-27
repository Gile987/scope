// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  buildChatCompletionRequestBody,
  inferChatCompletionRequestProfile,
  parseChatCompletionRequestProfile,
  resolveChatCompletionRequestProfile,
} from "./chat-completions.js";

const messages = [{ role: "user" as const, content: "ping" }];

describe("chat completion request bodies", () => {
  it.each(["gpt-5", "gpt-5.4-mini", "o1", "o4-mini"])(
    "suggests and uses the reasoning profile for %s",
    (model) => {
      expect(inferChatCompletionRequestProfile(model)).toBe("reasoning");
      expect(
        buildChatCompletionRequestBody({
          messages,
          model,
          maxTokens: 512,
          temperature: 0.3,
          requestProfile: "reasoning",
        }),
      ).toEqual({
        messages,
        model,
        max_completion_tokens: 512,
      });
    },
  );

  it("uses legacy parameters for non-reasoning models", () => {
    expect(
      buildChatCompletionRequestBody({
        messages,
        model: "gpt-4.1",
        maxTokens: 512,
        temperature: 0.3,
        requestProfile: "legacy",
      }),
    ).toEqual({
      messages,
      model: "gpt-4.1",
      max_tokens: 512,
      temperature: 0.3,
    });
  });

  it("uses an explicit profile instead of the model-name suggestion", () => {
    expect(
      buildChatCompletionRequestBody({
        messages,
        model: "custom-production-deployment",
        maxTokens: 512,
        temperature: 0.3,
        requestProfile: "reasoning",
      }),
    ).toEqual({
      messages,
      model: "custom-production-deployment",
      max_completion_tokens: 512,
    });
  });
});

describe("chat completion request profiles", () => {
  it("suggests the legacy profile for other and custom deployment names", () => {
    expect(inferChatCompletionRequestProfile("gpt-4.1")).toBe("legacy");
    expect(inferChatCompletionRequestProfile("custom-production-deployment")).toBe("legacy");
  });

  it("parses only supported explicit profiles", () => {
    expect(parseChatCompletionRequestProfile("legacy")).toBe("legacy");
    expect(parseChatCompletionRequestProfile("reasoning")).toBe("reasoning");
    expect(parseChatCompletionRequestProfile("future")).toBeUndefined();
  });

  it("prefers explicit configuration and otherwise infers a fallback", () => {
    expect(resolveChatCompletionRequestProfile("reasoning", "custom-name")).toBe("reasoning");
    expect(resolveChatCompletionRequestProfile(undefined, "gpt-5.4-mini")).toBe("reasoning");
  });
});
