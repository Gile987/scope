// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, afterEach } from "vitest";
import { JudgeClient, JudgeInfrastructureError } from "./judge-client.js";

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
