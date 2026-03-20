// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { withRetry, isCosmosDb429 } from "./retry.js";

describe("isCosmosDb429", () => {
  it("returns true for TooManyRequests error", () => {
    const err = new Error(
      "Response status code does not indicate success: TooManyRequests (429); Substatus: 3200"
    );
    expect(isCosmosDb429(err)).toBe(true);
  });

  it("returns true for 'Request rate is large' error", () => {
    const err = new Error("Request rate is large. More Request Units may be needed.");
    expect(isCosmosDb429(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCosmosDb429(new Error("Connection refused"))).toBe(false);
    expect(isCosmosDb429(null)).toBe(false);
    expect(isCosmosDb429(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on CosmosDB 429 and eventually succeeds", async () => {
    const cosmos429 = new Error(
      "Error=16500, RetryAfterMs=1, Details='TooManyRequests (429)'"
    );
    const fn = vi
      .fn()
      .mockRejectedValueOnce(cosmos429)
      .mockRejectedValueOnce(cosmos429)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately for non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Connection refused"));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow("Connection refused");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after maxRetries exhausted", async () => {
    const cosmos429 = new Error("TooManyRequests (429)");
    const fn = vi.fn().mockRejectedValue(cosmos429);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toThrow("TooManyRequests");
    // initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("supports custom isRetryable predicate", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("TIMEOUT"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      baseDelayMs: 1,
      isRetryable: (e) => e instanceof Error && e.message === "TIMEOUT",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
