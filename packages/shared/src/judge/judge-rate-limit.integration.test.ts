// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test: Judge rate-limit retry behavior.
 *
 * Spins up a lightweight HTTP server that simulates rate-limit responses
 * from the judge service, then verifies that JudgeClient retries correctly
 * and honors the server's suggested backoff duration.
 *
 * Uses short server-suggested backoff durations (1-3s) so tests exercise
 * the real retry path without waiting minutes. The differential test verifies
 * that longer hints produce longer waits.
 *
 * Run with: npx vitest run packages/shared/src/judge/judge-rate-limit.integration.test.ts
 */
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { JudgeClient } from "./judge-client.js";

/** Create a mock judge server that returns rate-limit errors for the first N calls */
function createMockJudgeServer(options: {
  rateLimitForCalls: number;
  rateLimitMessage?: string;
  successResponse?: object;
}): { server: Server; port: number; callCount: () => number; start: () => Promise<void>; stop: () => Promise<void> } {
  let callCount = 0;
  const {
    rateLimitForCalls,
    rateLimitMessage = "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period. Please try again in 5 seconds.",
    successResponse = { passed: true, feedback: "All criteria passed", criteriaResults: [{ criterionId: "c1", passed: true, feedback: "Good", evaluated: true }] },
  } = options;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
      return;
    }

    // Evaluate endpoint
    if (req.url === "/api/v1/evaluate" && req.method === "POST") {
      callCount++;
      if (callCount <= rateLimitForCalls) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(rateLimitMessage);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(successResponse));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  let port = 0;

  return {
    server,
    get port() { return port; },
    callCount: () => callCount,
    start: () => new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

describe("JudgeClient — rate-limit retry integration", () => {
  let mock: ReturnType<typeof createMockJudgeServer>;

  afterAll(async () => {
    if (mock) await mock.stop();
  });

  it("retries on rate-limit 500 and succeeds after backoff", async () => {
    // Rate limit for first 2 calls (1s backoff each), succeed on 3rd
    mock = createMockJudgeServer({
      rateLimitForCalls: 2,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 1 seconds.",
    });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 4,
    });

    const result = await client.evaluate({
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [],
    });

    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All criteria passed");
    expect(mock.callCount()).toBe(3); // 2 rate-limited + 1 success
  }, 10_000);

  it("reports rate-limit failure after all retries exhausted", async () => {
    // Always rate-limit (1s backoff, never succeeds)
    mock = createMockJudgeServer({
      rateLimitForCalls: 100,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 1 seconds.",
    });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 2,
    });

    await expect(
      client.evaluate({
        snapshotUrl: "https://example.com/snapshot.tar.gz",
        criteria: ["code compiles"],
        conversationHistory: [],
      })
    ).rejects.toThrow(/rate limit/i);

    // initial + 2 retries = 3 calls
    expect(mock.callCount()).toBe(3);
  }, 10_000);

  it("honors server-suggested backoff: longer hint produces longer wait", async () => {
    // Short hint: 1 second
    const shortMock = createMockJudgeServer({
      rateLimitForCalls: 1,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 1 seconds.",
    });
    await shortMock.start();

    const shortClient = new JudgeClient(`http://127.0.0.1:${shortMock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 3,
    });

    const shortStart = Date.now();
    await shortClient.evaluate({
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [],
    });
    const shortElapsed = Date.now() - shortStart;
    await shortMock.stop();

    // Long hint: 3 seconds
    const longMock = createMockJudgeServer({
      rateLimitForCalls: 1,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 3 seconds.",
    });
    await longMock.start();

    const longClient = new JudgeClient(`http://127.0.0.1:${longMock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 3,
    });

    const longStart = Date.now();
    await longClient.evaluate({
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [],
    });
    const longElapsed = Date.now() - longStart;
    await longMock.stop();

    // Both make exactly 2 calls (1 rate-limited + 1 success)
    expect(shortMock.callCount()).toBe(2);
    expect(longMock.callCount()).toBe(2);
    // Verify timing: short ~1s, long ~3s, differential >1.5s
    expect(shortElapsed).toBeGreaterThanOrEqual(900);
    expect(longElapsed).toBeGreaterThanOrEqual(2_800);
    expect(longElapsed).toBeGreaterThan(shortElapsed + 1_500);
  }, 10_000);

  it("succeeds immediately when no rate limit", async () => {
    mock = createMockJudgeServer({ rateLimitForCalls: 0 });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 2,
      rateLimitRetries: 4,
    });

    const result = await client.evaluate({
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [],
    });

    expect(result.passed).toBe(true);
    expect(mock.callCount()).toBe(1);
  }, 5_000);

  it("health check works against mock server", async () => {
    mock = createMockJudgeServer({ rateLimitForCalls: 0 });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(true);
  }, 5_000);
});

describe("JudgeClient — concurrency behavior", () => {
  it("handles multiple concurrent evaluate calls with intermittent rate limits", async () => {
    // First 3 calls get rate-limited (1s backoff), rest succeed
    const mock = createMockJudgeServer({
      rateLimitForCalls: 3,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 1 seconds.",
    });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 5,
    });

    const request = {
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [] as any[],
    };

    const results = await Promise.all([
      client.evaluate(request),
      client.evaluate(request),
      client.evaluate(request),
    ]);

    for (const result of results) {
      expect(result.passed).toBe(true);
    }

    await mock.stop();
  }, 10_000);
});
