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
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CLOSED = 2;

  readonly close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const entries = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  emit(type: string, event: MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function renderHook(attemptNumber: number) {
  const { useLogStream } = await import("./use-log-stream.js");
  const urlBuilder = stableUrlBuilder;
  runtime.beginRender();
  useLogStream({
    id: "run-1",
    enabled: true,
    fromStart: true,
    attemptNumber,
    urlBuilder,
  });
  runtime.beginRender();
  return useLogStream({
    id: "run-1",
    enabled: true,
    fromStart: true,
    attemptNumber,
    urlBuilder,
  });
}

const stableUrlBuilder = () => "/api/v1/runs/run-1/logs/stream";

describe("useLogStream", () => {
  beforeEach(() => {
    runtime.stateSlots = [];
    runtime.refSlots = [];
    runtime.effectSlots = [];
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.resetModules();
  });

  afterEach(() => {
    runtime.unmount();
    vi.unstubAllGlobals();
  });

  it("creates a new EventSource when attemptNumber changes", async () => {
    const initial = await renderHook(1);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(initial.logs).toEqual([]);

    const first = MockEventSource.instances[0];
    const updated = await renderHook(2);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(updated.logs).toEqual([]);
  });

  it("resets logs, done state, and error on reconnect", async () => {
    await renderHook(1);
    const first = MockEventSource.instances[0];
    expect(first).toBeDefined();

    first.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        timestamp: "2026-05-01T00:00:00.000Z",
        level: "info",
        message: "first attempt",
      }),
    }));
    first.emit("done", new MessageEvent("done"));
    first.emit("error", new MessageEvent("error", { data: JSON.stringify({ message: "boom" }) }));

    const beforeReconnect = await renderHook(1);
    expect(beforeReconnect.logs).toHaveLength(1);
    expect(beforeReconnect.isDone).toBe(true);
    expect(beforeReconnect.error).toBe("boom");

    const afterReconnect = await renderHook(2);
    expect(afterReconnect.logs).toEqual([]);
    expect(afterReconnect.isDone).toBe(false);
    expect(afterReconnect.error).toBeNull();
  });
});
