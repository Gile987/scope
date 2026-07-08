// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { withRetry, type RetryOptions } from "shared";

/** True when an error looks like an HTTP 429 / rate-limit response. */
export function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|too many requests/i.test(message);
}

/**
 * Default backoff for a real-LLM eval call. The free tier resets on a ~60s
 * sliding window, so a high retry ceiling lets a throttled call eventually land
 * rather than flaking a required check.
 */
export const DEFAULT_RATE_LIMIT_RETRY: RetryOptions = {
  maxRetries: 10,
  baseDelayMs: 5_000,
  maxDelayMs: 30_000,
  isRetryable: isRateLimit,
};

/**
 * Wrap a real-LLM call so ONLY rate-limit (429) errors are retried, with
 * exponential backoff. Real failures (bad requests, parse errors, orientation
 * misses that throw) surface immediately instead of being masked by retries.
 * Pass `overrides` to tune the backoff for a specific eval.
 */
export function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  overrides?: RetryOptions,
): Promise<T> {
  return withRetry(fn, { ...DEFAULT_RATE_LIMIT_RETRY, ...overrides });
}
