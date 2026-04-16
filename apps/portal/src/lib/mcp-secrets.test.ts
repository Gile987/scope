// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { unmaskSecretValue } from "./mcp-secrets";

describe("unmaskSecretValue", () => {
  it('returns empty string for the masked sentinel "<secret>"', () => {
    expect(unmaskSecretValue("<secret>")).toBe("");
  });

  it("returns the value unchanged when it is not masked", () => {
    expect(unmaskSecretValue("my-real-token")).toBe("my-real-token");
  });

  it("returns empty string unchanged", () => {
    expect(unmaskSecretValue("")).toBe("");
  });

  it("does not treat a partial match as masked", () => {
    expect(unmaskSecretValue("not-<secret>-here")).toBe("not-<secret>-here");
  });

  it("is case-sensitive — does not treat <SECRET> as masked", () => {
    expect(unmaskSecretValue("<SECRET>")).toBe("<SECRET>");
  });
});
