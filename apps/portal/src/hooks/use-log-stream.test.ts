// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CleanupFn = (() => void) | void;

class HookRuntime {
  stateSlots: unknown[] = [];
  refSlots: Array<{ current: unknown }> = [];
  effectSlots: Array<{ deps?: unknown[]; cleanup?: CleanupFn }> = [];
  stateIndex = 0;
  refIndex = 0;
  effectIndex = 0;

  beginRender() {
    this.stateIndex = 0;
    this.refIndex = 0;
    this.effectIndex = 0;
  }

  unmount() {
    for (const effect of this.effectSlots) effect.cleanup?.();
    this.effectSlots = [];
  }
}

const runtime = new HookRuntime();
const apiFetchMock = vi.fn();

vi.mock("react", () => ({
  useState<T>(initialValue: T | (() => T)) {
    const index = runtime.stateIndex++;
    if (runtime.stateSlots[index] === undefined) {
      runtime.stateSlots[index] =
        typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    }
    const setState = (value: T | ((prev: T) => T)) => {
      const prev = runtime.stateSlots[index] as T;
      runtime.stateSlots[index] = typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
    };
    return [runtime.stateSlots[index] as T, setState] as const;
  },
  useRef<T>(initialValue: T) {
    const index = runtime.refIndex++;
    if (!runtime.refSlots[index]) runtime.refSlots[index] = { current: initialValue };
    return runtime.refSlots[index] as { current: T };
  },
  useEffect(effect: () => CleanupFn, deps?: unknown[]) {
    const index = runtime.effectIndex++;
    const current = runtime.effectSlots[index];
    const changed = !current?.deps
      || !deps
      || current.deps.length !== deps.length
      || deps.some((dep, i) => dep !== current.deps?.[i]);
    if (!changed) return;

    current?.cleanup?.();
    runtime.effectSlots[index] = {
      deps,
      cleanup: effect(),
    };
  },
  useCallback<T extends (...args: never[]) => unknown>(fn: T) {
    return fn;
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    logsUrl: (_id: string, _fromStart: boolean) => "/api/v1/runs/run-1/logs/stream",
  },
  apiFetch: apiFetchMock,
}));

async function renderHook(attemptNumber: number) {
  const { useLogStream } = await import("./use-log-stream.js");
  runtime.beginRender();
  return useLogStream({
    id: "run-1",
    enabled: true,
    fromStart: true,
    attemptNumber,
    urlBuilder: stableUrlBuilder,
  });
}

const stableUrlBuilder = () => "/api/v1/runs/run-1/logs/stream";

describe("useLogStream", () => {
  beforeEach(() => {
    runtime.stateSlots = [];
    runtime.refSlots = [];
    runtime.effectSlots = [];
    apiFetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    runtime.unmount();
  });

  it("starts a new authenticated fetch stream when attemptNumber changes", async () => {
    apiFetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    const initial = await renderHook(1);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(initial.logs).toEqual([]);

    const firstSignal = getSignal(apiFetchMock.mock.calls[0][1]);
    await renderHook(2);

    expect(firstSignal.aborted).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses log, done, and error events from fetch-streamed SSE", async () => {
    apiFetchMock.mockResolvedValue(makeSseResponse([
      'data: {"timestamp":"2026-05-01T00:00:00.000Z","level":"info","message":"hello"}\n\n',
      "event: done\n\n",
    ]));

    await renderHook(1);
    await flushPromises();
    const afterStream = await renderHook(1);

    expect(afterStream.logs).toEqual([
      {
        timestamp: "2026-05-01T00:00:00.000Z",
        level: "info",
        message: "hello",
      },
    ]);
    expect(afterStream.isDone).toBe(true);
    expect(afterStream.error).toBeNull();
  });
});

function getSignal(init: unknown): AbortSignal {
  if (!isRecord(init) || !(init.signal instanceof AbortSignal)) {
    throw new Error("Expected apiFetch init with AbortSignal");
  }
  return init.signal;
}

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
