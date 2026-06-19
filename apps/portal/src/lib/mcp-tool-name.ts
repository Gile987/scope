// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for detecting and presenting MCP tool calls in the conversation view.
 *
 * GitHub Copilot CLI (and the ACP workers) expose MCP server tools to the model
 * using the convention `<serverName>-<toolName>`. Built-in tools (e.g. `bash`,
 * `view`, `edit`) carry no server prefix. Given the list of MCP server names
 * configured on a run, we can detect which tool calls came from an MCP server
 * and split out the server + tool name for display.
 */

export interface McpToolInfo {
  /** Whether this tool call resolved to a configured MCP server. */
  isMcp: boolean;
  /** The MCP server name (only set when `isMcp` is true). */
  server?: string;
  /** The tool name with the server prefix stripped (falls back to the raw name). */
  tool: string;
}

/**
 * Resolve MCP metadata for a tool call name against the run's configured MCP
 * server names. When multiple prefixes match, the longest one wins so that
 * overlapping server names resolve to the most specific match.
 */
export function resolveMcpToolName(
  name: string,
  mcpServerNames: readonly string[] = [],
): McpToolInfo {
  let best: { server: string; tool: string } | undefined;

  for (const server of mcpServerNames) {
    if (!server) continue;
    const prefix = `${server}-`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      const tool = name.slice(prefix.length);
      if (!best || server.length > best.server.length) {
        best = { server, tool };
      }
    }
  }

  if (best) {
    return { isMcp: true, server: best.server, tool: best.tool };
  }
  return { isMcp: false, tool: name };
}
