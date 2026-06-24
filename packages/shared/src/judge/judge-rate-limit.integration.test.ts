// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test: Judge rate-limit retry behavior.
 *
 * Spins up a lightweight HTTP server that simulates rate-limit responses
 * from the judge service, then verifies that JudgeClient retries correctly
 * and honors the server's suggested backoff duration.
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
    // Rate limit for first 2 calls, succeed on 3rd
    mock = createMockJudgeServer({ rateLimitForCalls: 2 });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 4, // enough to survive 2 rate-limit responses
    });

    const result = await client.evaluate({
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [],
    });

    expect(result.passed).toBe(true);
    expect(result.feedback).toBe("All criteria passed");
    expect(mock.callCount()).toBe(3); // 2 rate-limited + 1 success
  }, 120_000);

  it("reports rate-limit failure after all retries exhausted", async () => {
    // Always rate-limit (never succeeds)
    mock = createMockJudgeServer({ rateLimitForCalls: 100 });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 10_000,
      maxRetries: 1,
      rateLimitRetries: 2, // only 2 retries
    });

    await expect(
      client.evaluate({
        snapshotUrl: "https://example.com/snapshot.tar.gz",
        criteria: ["code compiles"],
        conversationHistory: [],
      })
    ).rejects.toThrow(/rate limit/i);

    // Should have attempted initial call + 2 retries = 3 calls
    expect(mock.callCount()).toBe(3);
  }, 120_000);

  it("honors server-suggested backoff: longer hint produces longer wait", async () => {
    // Test with a short hint (2 seconds)
    const shortMock = createMockJudgeServer({
      rateLimitForCalls: 1,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 2 seconds.",
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

    // Test with a longer hint (8 seconds)
    const longMock = createMockJudgeServer({
      rateLimitForCalls: 1,
      rateLimitMessage: "Sorry, you've hit a rate limit. Please try again in 8 seconds.",
    });
    await longMock.start();

    const longClient = new JudgeClient(`http://127.0.0.1:${longMock.port}`, {
      timeoutMs: 30_000,
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

    // The "8 seconds" hint should produce a measurably longer wait than "2 seconds"
    expect(shortMock.callCount()).toBe(2);
    expect(longMock.callCount()).toBe(2);
    expect(shortElapsed).toBeGreaterThanOrEqual(1_500); // at least ~2s wait
    expect(longElapsed).toBeGreaterThanOrEqual(7_000);  // at least ~8s wait
    expect(longElapsed).toBeGreaterThan(shortElapsed + 3_000); // differential: long is meaningfully longer
  }, 30_000);

  it("succeeds immediately when no rate limit", async () => {
    mock = createMockJudgeServer({ rateLimitForCalls: 0 }); // Never rate-limit
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
    expect(mock.callCount()).toBe(1); // single call, no retries
  }, 10_000);

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
    // Simulate a batch scenario: first 3 calls get rate-limited, rest succeed
    const mock = createMockJudgeServer({ rateLimitForCalls: 3 });
    await mock.start();

    const client = new JudgeClient(`http://127.0.0.1:${mock.port}`, {
      timeoutMs: 30_000,
      maxRetries: 1,
      rateLimitRetries: 5,
    });

    const request = {
      snapshotUrl: "https://example.com/snapshot.tar.gz",
      criteria: ["code compiles"],
      conversationHistory: [] as any[],
    };

    // Fire 3 concurrent evaluate calls
    const results = await Promise.all([
      client.evaluate(request),
      client.evaluate(request),
      client.evaluate(request),
    ]);

    // All should eventually succeed
    for (const result of results) {
      expect(result.passed).toBe(true);
    }

    await mock.stop();
  }, 120_000);
});
