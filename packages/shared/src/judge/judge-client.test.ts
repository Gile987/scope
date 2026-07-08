// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import { isRateLimitError, parseRateLimitBackoff } from "./judge-client.js";
import {
  JudgeClient,
  JudgeInfrastructureError,
  isRetryableJudgeError,
} from "./judge-client.js";

function mockFetchResponse(opts: {
  ok: boolean;
  status: number;
  body?: string;
  json?: unknown;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: opts.ok,
      status: opts.status,
      text: async () => opts.body ?? "",
      json: async () => opts.json ?? {},
    })
  );
}

const request = {
  snapshotUrl: "https://example/snap.tar.gz",
  criteria: ["c1"],
  conversationHistory: [],
};

describe("isRateLimitError", () => {
  it("detects 'rate limit' in error message", () => {
    expect(isRateLimitError(new Error("Sorry, you've hit a rate limit"))).toBe(true);
  });

  it("detects 'rate-limit' (hyphenated)", () => {
    expect(isRateLimitError(new Error("rate-limit exceeded"))).toBe(true);
  });

  it("detects 'Too Many Requests'", () => {
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("detects '429' with 'rate'", () => {
    expect(isRateLimitError(new Error("429 rate throttled"))).toBe(true);
  });

  it("does not match unrelated 429 errors without rate", () => {
    expect(isRateLimitError(new Error("HTTP 429 generic throttle"))).toBe(false);
  });

  it("does not match timeout errors", () => {
    expect(isRateLimitError(new Error("The operation was aborted"))).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("handles string errors", () => {
    expect(isRateLimitError("rate limit reached")).toBe(true);
  });
});

describe("parseRateLimitBackoff", () => {
  it("parses 'try again in 5 minutes'", () => {
    const err = new Error("Sorry, you've hit a rate limit. Please try again in 5 minutes.");
    expect(parseRateLimitBackoff(err)).toBe(5 * 60 * 1000);
  });

  it("parses 'try again in 5 hours' and caps at 30 minutes", () => {
    const err = new Error("Please try again in 5 hours.");
    expect(parseRateLimitBackoff(err)).toBe(30 * 60 * 1000); // Capped
  });

  it("parses 'try again in 30 seconds'", () => {
    const err = new Error("Please try again in 30 seconds.");
    expect(parseRateLimitBackoff(err)).toBe(30 * 1000);
  });

  it("returns default when no parseable duration", () => {
    const err = new Error("Rate limit hit, please wait");
    expect(parseRateLimitBackoff(err)).toBe(5 * 60 * 1000); // default
  });

  it("returns custom default when provided", () => {
    const err = new Error("Rate limit hit");
    expect(parseRateLimitBackoff(err, 60_000)).toBe(60_000);
  });

  it("handles null/undefined", () => {
    expect(parseRateLimitBackoff(null)).toBe(5 * 60 * 1000);
    expect(parseRateLimitBackoff(undefined)).toBe(5 * 60 * 1000);
  });
});

describe("JudgeClient error classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws JudgeInfrastructureError with isVersionMismatch on protocol mismatch", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      body: '{"error":"Judge evaluation failed: SDK protocol version mismatch: SDK expects version 2, but server reports version 3."}',
    });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(JudgeInfrastructureError);
    expect((error as JudgeInfrastructureError).isVersionMismatch).toBe(true);
    expect((error as JudgeInfrastructureError).httpStatus).toBe(500);
  });

  it("throws JudgeInfrastructureError (not version mismatch) on generic 5xx", async () => {
    mockFetchResponse({ ok: false, status: 503, body: "upstream unavailable" });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(JudgeInfrastructureError);
    expect((error as JudgeInfrastructureError).isVersionMismatch).toBe(false);
  });

  it("throws a plain Error (not infrastructure) on a 4xx", async () => {
    mockFetchResponse({ ok: false, status: 400, body: "bad request" });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const error = await client.evaluate(request).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(JudgeInfrastructureError);
  });

  it("returns the parsed result on success", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      json: { passed: true, feedback: "All requirements met." },
    });
    const client = new JudgeClient("http://judge", { maxRetries: 0 });

    const result = await client.evaluate(request);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All requirements met.");
  });
});

describe("isRetryableJudgeError", () => {
  it("retries transient judge-side 5xx infrastructure errors", () => {
    const err = new JudgeInfrastructureError("judge boom", {
      httpStatus: 503,
      isVersionMismatch: false,
    });
    expect(isRetryableJudgeError(err)).toBe(true);
  });

  it("does NOT retry a protocol version mismatch (won't self-heal)", () => {
    const err = new JudgeInfrastructureError("protocol mismatch", {
      httpStatus: 500,
      isVersionMismatch: true,
    });
    expect(isRetryableJudgeError(err)).toBe(false);
  });

  it("does NOT retry 4xx infrastructure errors", () => {
    const err = new JudgeInfrastructureError("bad request", {
      httpStatus: 400,
      isVersionMismatch: false,
    });
    expect(isRetryableJudgeError(err)).toBe(false);
  });

  it("retries transient network failures", () => {
    expect(isRetryableJudgeError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableJudgeError(new Error("The operation was aborted"))).toBe(true);
  });

  it("does not retry unrelated errors", () => {
    expect(isRetryableJudgeError(new Error("criteria not met"))).toBe(false);
    expect(isRetryableJudgeError(null)).toBe(false);
  });
});
