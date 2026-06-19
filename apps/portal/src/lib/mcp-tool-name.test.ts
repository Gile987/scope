// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { resolveMcpToolName } from "./mcp-tool-name";

describe("resolveMcpToolName", () => {
  it("returns built-in tools unchanged when no servers configured", () => {
    expect(resolveMcpToolName("bash")).toEqual({ isMcp: false, tool: "bash" });
  });

  it("does not flag built-in tools that don't match a server prefix", () => {
    expect(resolveMcpToolName("view", ["github-mcp-server"])).toEqual({
      isMcp: false,
      tool: "view",
    });
  });

  it("detects an MCP tool and splits server + tool name", () => {
    expect(resolveMcpToolName("github-mcp-server-search_code", ["github-mcp-server"])).toEqual({
      isMcp: true,
      server: "github-mcp-server",
      tool: "search_code",
    });
  });

  it("prefers the longest matching server prefix", () => {
    const result = resolveMcpToolName("github-mcp-server-search_code", [
      "github",
      "github-mcp-server",
    ]);
    expect(result).toEqual({
      isMcp: true,
      server: "github-mcp-server",
      tool: "search_code",
    });
  });

  it("ignores empty server names", () => {
    expect(resolveMcpToolName("-foo", [""])).toEqual({ isMcp: false, tool: "-foo" });
  });

  it("requires a non-empty tool name after the prefix", () => {
    expect(resolveMcpToolName("server-", ["server"])).toEqual({
      isMcp: false,
      tool: "server-",
    });
  });
});
