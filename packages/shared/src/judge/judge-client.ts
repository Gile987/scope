// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ConversationTurn, CriterionResult } from "../types/types.js";

/**
 * Request payload for the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateRequest {
  snapshotUrl: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  requestId?: string;  // Enables the judge to publish real-time progress via Redis
}

/**
 * Response from the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateResponse {
  passed: boolean;
  feedback: string;
  criteriaResults?: CriterionResult[];  // Per-criterion results for DAG status tracking
}

export interface JudgeClientOptions {
  /** Timeout in ms for evaluate requests (default: JUDGE_CLIENT_TIMEOUT env or 600000 = 10 minutes) */
  timeoutMs?: number;
  /** Maximum retry attempts on timeout/transient errors (default: JUDGE_CLIENT_RETRIES env or 2) */
  maxRetries?: number;
  /** Maximum retry attempts specifically for rate-limit errors (default: JUDGE_CLIENT_RATE_LIMIT_RETRIES env or 6) */
  rateLimitRetries?: number;
}

/** Default timeout for judge evaluate requests (10 minutes) */
const DEFAULT_JUDGE_CLIENT_TIMEOUT = 10 * 60 * 1000;
/** Default retry attempts for judge evaluate requests */
const DEFAULT_JUDGE_CLIENT_RETRIES = 2;
/** Default retry attempts for rate-limit errors (longer waits, more attempts) */
const DEFAULT_JUDGE_CLIENT_RATE_LIMIT_RETRIES = 6;

/**
 * Returns true if the error is a timeout or transient network failure
 * that warrants a retry of the judge evaluation.
 */
function isRetryableJudgeError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("The operation was aborted") ||
    msg.includes("TimeoutError") ||
    msg.includes("abort") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    isRateLimitError(error)
  );
}

/**
 * Returns true if the error indicates a Copilot model rate limit.
 * These errors contain specific phrases from the Copilot rate-limit response.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("Too Many Requests") ||
    (msg.includes("429") && msg.includes("rate"))
  );
}

/**
 * Parses the suggested backoff duration from a Copilot rate-limit error message.
 * Looks for patterns like "try again in 5 minutes" or "try again in 5 hours".
 * Returns the backoff duration in milliseconds, or the provided default if unparseable.
 */
export function parseRateLimitBackoff(error: unknown, defaultMs = 5 * 60 * 1000): number {
  const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes cap
  if (!error) return defaultMs;
  const msg = error instanceof Error ? error.message : String(error);

  const match = msg.match(/try again in (\d+)\s*(minute|hour|second)/i);
  if (!match) return defaultMs;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let ms: number;
  if (unit.startsWith("hour")) {
    ms = value * 60 * 60 * 1000;
  } else if (unit.startsWith("minute")) {
    ms = value * 60 * 1000;
  } else {
    ms = value * 1000;
  }

  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Client for calling the judge REST API from coding workers.
 */
export class JudgeClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private rateLimitRetries: number;

  constructor(baseUrl: string, options?: JudgeClientOptions) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options?.timeoutMs
      ?? parseInt(process.env.JUDGE_CLIENT_TIMEOUT || String(DEFAULT_JUDGE_CLIENT_TIMEOUT));
    this.maxRetries = options?.maxRetries
      ?? parseInt(process.env.JUDGE_CLIENT_RETRIES || String(DEFAULT_JUDGE_CLIENT_RETRIES));
    this.rateLimitRetries = options?.rateLimitRetries
      ?? parseInt(process.env.JUDGE_CLIENT_RATE_LIMIT_RETRIES || String(DEFAULT_JUDGE_CLIENT_RATE_LIMIT_RETRIES));
  }

  /**
   * Calls the judge service to evaluate a workspace snapshot against criteria.
   * Retries on timeout, transient network errors, and rate-limit errors.
   *
   * Rate-limit errors honor the server's suggested backoff duration (e.g.
   * "try again in 5 minutes") rather than using a fixed exponential schedule.
   * Non-rate-limit transient errors use exponential backoff with jitter.
   */
  async evaluate(request: JudgeEvaluateRequest): Promise<JudgeEvaluateResponse> {
    const url = `${this.baseUrl}/api/v1/evaluate`;
    const criteriaCount = request.criteria.length;
    const effectiveRetries = Math.max(this.maxRetries, this.rateLimitRetries);

    console.log(
      `[JudgeClient] Evaluating ${criteriaCount} criteria (timeout: ${this.timeoutMs}ms, retries: ${this.maxRetries}, rateLimitRetries: ${this.rateLimitRetries})`
    );

    let lastError: unknown;
    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      try {
        return await this.doEvaluate(url, request);
      } catch (error) {
        lastError = error;
        if (attempt >= effectiveRetries || !isRetryableJudgeError(error)) {
          throw error;
        }

        const msg = error instanceof Error ? error.message : String(error);
        let delayMs: number;

        if (isRateLimitError(error)) {
          // Honor the server's suggested backoff duration
          delayMs = parseRateLimitBackoff(error);
          console.warn(
            `[JudgeClient] Rate limit hit on attempt ${attempt + 1}/${effectiveRetries} (waiting ${Math.round(delayMs / 1000)}s before retry): ${msg.substring(0, 200)}`
          );
        } else {
          // Exponential backoff with jitter for transient errors
          delayMs = Math.min(5_000 * Math.pow(2, attempt), 5 * 60 * 1000) + Math.random() * 1_000;
          console.warn(
            `[JudgeClient] Evaluate attempt ${attempt + 1}/${effectiveRetries} failed (retrying in ${Math.round(delayMs / 1000)}s): ${msg.substring(0, 200)}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  private async doEvaluate(url: string, request: JudgeEvaluateRequest): Promise<JudgeEvaluateResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new Error(
        `Judge evaluation failed (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as JudgeEvaluateResponse;

    if (typeof result.passed !== "boolean" || typeof result.feedback !== "string") {
      throw new Error(
        `Invalid judge response: expected {passed: boolean, feedback: string}, got ${JSON.stringify(result)}`
      );
    }

    return {
      passed: result.passed,
      feedback: result.feedback,
      criteriaResults: result.criteriaResults,
    };
  }

  /**
   * Health check for the judge service.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
