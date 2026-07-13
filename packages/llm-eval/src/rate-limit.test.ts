// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { isRateLimit, withRateLimitRetry } from "./rate-limit.js";

describe("isRateLimit", () => {
  it("matches 429 / rate-limit phrasing", () => {
    expect(isRateLimit(new Error("Request failed with status 429"))).toBe(true);
    expect(isRateLimit(new Error("Rate limit of 15 per 60s exceeded"))).toBe(true);
    expect(isRateLimit(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimit("429 rate limit")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isRateLimit(new Error("bad request"))).toBe(false);
    expect(isRateLimit(new Error("500 internal"))).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
  });
});

describe("withRateLimitRetry", () => {
  // Tiny backoff so the retry path is fast in unit tests.
  const fastBackoff = { baseDelayMs: 1, maxDelayMs: 5, maxRetries: 4 };

  it("retries a 429 then resolves", async () => {
    let attempts = 0;
    const result = await withRateLimitRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("429 rate limit");
      return "ok";
    }, fastBackoff);

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry a non-rate-limit error (fails fast)", async () => {
    let attempts = 0;
    await expect(
      withRateLimitRetry(async () => {
        attempts++;
        throw new Error("validation failed");
      }, fastBackoff),
    ).rejects.toThrow("validation failed");

    expect(attempts).toBe(1);
  });
});
