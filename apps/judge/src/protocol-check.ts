// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient } from "@github/copilot-sdk";

/**
 * Boot-time guard asserting the bundled Copilot CLI speaks the ACP protocol
 * version expected by the installed `@github/copilot-sdk`.
 *
 * Drift here — e.g. a pnpm override bumping the bundled `@github/copilot` CLI ahead
 * of the SDK — otherwise surfaces as an opaque per-evaluation HTTP 500 inside
 * `@github/copilot-sdk`, aborting every gated run at the first gate. Verifying at
 * startup turns that silent drift into a loud, actionable boot failure.
 *
 * `CopilotClient.start()` spawns the bundled CLI and internally calls
 * `verifyProtocolVersion()`, which throws on a mismatch — so a successful `start()`
 * proves SDK<->CLI compatibility.
 */
export async function verifyCopilotProtocol(timeoutMs = 30_000): Promise<void> {
  const client = new CopilotClient();
  try {
    await withTimeout(
      client.start(),
      timeoutMs,
      `Copilot CLI did not start within ${timeoutMs}ms`
    );
    const status = await client.getStatus();
    console.log(
      `[judge] Copilot SDK<->CLI protocol OK (CLI v${status.version}, protocol v${status.protocolVersion})`
    );
  } finally {
    // Best-effort cleanup; never mask the original error.
    await client.stop().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
