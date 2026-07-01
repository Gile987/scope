// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { buildSubprocessEnv } from "./index.js";

describe("buildSubprocessEnv", () => {
  const token = "gho_test_token_1234567890";

  describe("when DevProxy is enabled", () => {
    it("sets NODE_OPTIONS with --use-env-proxy", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env.NODE_OPTIONS).toBe("--use-env-proxy");
    });

    it("appends --use-env-proxy to existing NODE_OPTIONS", () => {
      const env = buildSubprocessEnv(token, true, "--max-old-space-size=4096");
      expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --use-env-proxy");
    });

    it("disables TLS verification for MITM proxy", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
    });

    it("does not set proxy env vars without proxyUrl", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env).not.toHaveProperty("HTTP_PROXY");
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env).not.toHaveProperty("http_proxy");
      expect(env).not.toHaveProperty("https_proxy");
    });

    it("sets proxy env vars when proxyUrl is provided", () => {
      const proxyUrl = "http://session-123@gateway:18000";
      const env = buildSubprocessEnv(token, true, undefined, undefined, proxyUrl);
      expect(env.HTTP_PROXY).toBe(proxyUrl);
      expect(env.HTTPS_PROXY).toBe(proxyUrl);
      expect(env.http_proxy).toBe(proxyUrl);
      expect(env.https_proxy).toBe(proxyUrl);
    });

    it("does not set NODE_EXTRA_CA_CERTS (inherits from process.env)", () => {
      const env = buildSubprocessEnv(token, true);
      expect(env).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    });
  });

  describe("when DevProxy is disabled", () => {
    it("clears all proxy env vars", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env.HTTP_PROXY).toBe("");
      expect(env.HTTPS_PROXY).toBe("");
      expect(env.http_proxy).toBe("");
      expect(env.https_proxy).toBe("");
    });

    it("clears NODE_EXTRA_CA_CERTS to prevent stale cert warnings", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env.NODE_EXTRA_CA_CERTS).toBe("");
    });

    it("does not set NODE_OPTIONS or NODE_TLS_REJECT_UNAUTHORIZED", () => {
      const env = buildSubprocessEnv(token, false);
      expect(env).not.toHaveProperty("NODE_OPTIONS");
      expect(env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
    });
  });

  it("always includes GITHUB_TOKEN", () => {
    expect(buildSubprocessEnv(token, true).GITHUB_TOKEN).toBe(token);
    expect(buildSubprocessEnv(token, false).GITHUB_TOKEN).toBe(token);
  });

  it("always disables the CLI auto-updater (issue #1179)", () => {
    expect(buildSubprocessEnv(token, true).COPILOT_AUTO_UPDATE).toBe("false");
    expect(buildSubprocessEnv(token, false).COPILOT_AUTO_UPDATE).toBe("false");
  });
});
