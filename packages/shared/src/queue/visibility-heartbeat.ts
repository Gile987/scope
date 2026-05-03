// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { QueueClient } from "@azure/storage-queue";

/** How often to extend message visibility (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Each heartbeat extends visibility by this many seconds. */
export const HEARTBEAT_VISIBILITY_SECONDS = 30;

/**
 * Handle returned by {@link startVisibilityHeartbeat}.
 */
export interface VisibilityHeartbeat {
  /** Stop the heartbeat and return the latest pop receipt. Idempotent. */
  stop(): string;
  /** Current pop receipt (updated by each heartbeat tick). */
  readonly popReceipt: string;
}

/**
 * Start a background loop that periodically extends a queue message's
 * visibility timeout via `QueueClient.updateMessage`. This keeps the message
 * hidden from other workers as long as this process is alive. If the worker
 * crashes, the heartbeat dies and the message reappears after at most
 * {@link HEARTBEAT_VISIBILITY_SECONDS} (default 30 s) instead of the
 * previous 35-minute single-shot extension.
 *
 * @returns A handle to stop the heartbeat and retrieve the latest pop receipt.
 */
export function startVisibilityHeartbeat(
  queueClient: QueueClient,
  messageId: string,
  initialPopReceipt: string,
  workerName: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  visibilityTimeoutSeconds: number = HEARTBEAT_VISIBILITY_SECONDS,
): VisibilityHeartbeat {
  let popReceipt = initialPopReceipt;
  const abort = new AbortController();

  const loop = async () => {
    while (!abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (abort.signal.aborted) break;
      try {
        const response = await queueClient.updateMessage(
          messageId, popReceipt, undefined, visibilityTimeoutSeconds,
        );
        popReceipt = response.popReceipt!;
      } catch (error) {
        if (abort.signal.aborted) break;
        console.warn(`[${workerName}] Visibility heartbeat failed:`, error);
      }
    }
  };

  loop().catch(() => {}); // fire-and-forget

  return {
    stop: () => { abort.abort(); return popReceipt; },
    get popReceipt() { return popReceipt; },
  };
}
