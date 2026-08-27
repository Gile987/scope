// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  buildFoundryCredentialValue,
  inferFoundryRequestProfile,
} from "./CreateToken.js";

describe("Foundry request compatibility", () => {
  it("suggests profiles from known model names", () => {
    expect(inferFoundryRequestProfile("gpt-5.4-mini")).toBe("reasoning");
    expect(inferFoundryRequestProfile("o4-mini")).toBe("reasoning");
    expect(inferFoundryRequestProfile("gpt-4.1")).toBe("legacy");
  });

  it("persists the suggested profile when no override is provided", () => {
    expect(
      JSON.parse(
        buildFoundryCredentialValue({
          endpoint: "https://example.services.ai.azure.com/models/",
          apiKey: "test-key",
          model: "gpt-5.4-mini",
        }),
      ),
    ).toEqual({
      endpoint: "https://example.services.ai.azure.com/models",
      apiKey: "test-key",
      model: "gpt-5.4-mini",
      requestProfile: "reasoning",
    });
  });

  it("persists a user override for a custom deployment name", () => {
    const value = JSON.parse(
      buildFoundryCredentialValue({
        endpoint: "https://example.services.ai.azure.com/models",
        apiKey: "test-key",
        model: "custom-production-deployment",
        requestProfile: "reasoning",
      }),
    );
    expect(value.requestProfile).toBe("reasoning");
  });
});
