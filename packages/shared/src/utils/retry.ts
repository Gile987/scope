// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Retry utility for transient failures (e.g. CosmosDB 429 TooManyRequests).
 *
 * Uses exponential backoff with jitter. When the error includes a
 * `RetryAfterMs` hint from CosmosDB, it is respected as the minimum delay.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5) */
  maxRetries?: number;
  /** Base delay in ms before the first retry (default: 100) */
  baseDelayMs?: number;
  /** Maximum delay in ms between retries (default: 5000) */
  maxDelayMs?: number;
  /** Predicate to decide if an error is retryable. Defaults to isCosmosDb429. */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Returns true if the error is a CosmosDB 429 (TooManyRequests) or a
 * MongoDB driver wrapper around one.
 */
export function isCosmosDb429(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("TooManyRequests") || msg.includes("Request rate is large");
}

/**
 * Extracts the RetryAfterMs value from a CosmosDB 429 error message, if present.
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/RetryAfterMs=(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Executes `fn` and retries on transient errors with exponential backoff + jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = options?.isRetryable ?? isCosmosDb429;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff: baseDelay * 2^attempt, capped at maxDelay
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      // Add jitter: 50%-100% of the computed delay
      const jitteredDelay = cappedDelay * (0.5 + Math.random() * 0.5);
      // Respect CosmosDB RetryAfterMs hint if present
      const retryAfterMs = extractRetryAfterMs(error);
      const delay = Math.max(jitteredDelay, retryAfterMs ?? 0);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable, but TypeScript needs it
  throw lastError;
}
