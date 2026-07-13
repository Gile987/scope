// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test: real Copilot SDK <-> bundled CLI protocol compatibility.
 *
 * Unlike protocol-check.test.ts (which mocks @github/copilot-sdk), this spawns
 * the REAL bundled Copilot CLI from the installed dependency tree and asserts
 * the SDK and CLI negotiate a compatible ACP protocol version.
 *
 * This is the direct regression guard for growth-ecosystems/scope-doc#64: a
 * dependency graph where the bundled @github/copilot CLI drifts ahead of (or
 * behind) @github/copilot-sdk would make verifyProtocolVersion() throw here,
 * instead of surfacing as an opaque per-evaluation HTTP 500 in production.
 *
 * No GitHub token is required — start()/getStatus() only spawn the CLI and
 * perform the local ACP handshake; they do not authenticate or call models.
 */
import { describe, it, expect } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import { verifyCopilotProtocol } from "./protocol-check.js";

describe("judge Copilot SDK<->CLI protocol (integration)", () => {
  it("boots the bundled CLI and negotiates a compatible protocol version", async () => {
    // Resolves only when the real SDK and real bundled CLI agree on the ACP
    // protocol version; throws on the exact mismatch that caused scope-doc#64.
    await expect(verifyCopilotProtocol(60_000)).resolves.toBeUndefined();
  }, 120_000);

  it("reports a concrete CLI version and a positive protocol version", async () => {
    const client = new CopilotClient();
    try {
      await client.start();
      const status = await client.getStatus();

      expect(typeof status.version).toBe("string");
      expect(status.version.length).toBeGreaterThan(0);
      expect(typeof status.protocolVersion).toBe("number");
      expect(status.protocolVersion).toBeGreaterThan(0);
    } finally {
      // stop() resolves with collected errors rather than throwing.
      await client.stop().catch(() => undefined);
    }
  }, 120_000);
});
