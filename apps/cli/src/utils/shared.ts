// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { dimTimestamp, label, value } from "./style.js";
import { generateOutputFormatsHelp } from "./helpFormatter.js";

/** Strip trailing slashes from a URL to avoid double-slash issues when appending paths */
export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

export function printFollowUpCommands(id: string): void {
  console.log(`\n${label('Run ID:')} ${value(id)}`);
  console.log(`\n${label('Next steps:')}`);
  console.log(`  ${dimTimestamp('Get details:')}   pnpm cli run get -i ${id}`);
  console.log(`  ${dimTimestamp('Check status:')}  pnpm cli run status -i ${id}`);
  console.log(`  ${dimTimestamp('Stream logs:')}   pnpm cli run logs -i ${id}`);
  console.log(`  ${dimTimestamp('Download:')}      pnpm cli run download -i ${id}`);
  console.log(`  ${dimTimestamp('List all runs:')} pnpm cli run list`);
}

export const DEFAULT_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot"
];

// Output format definitions with descriptions and categories
export const OUTPUT_FORMATS = {
  table: { section: 'Human-readable formats', description: 'Formatted table with borders (default for lists)' },
  tsv:   { section: 'Machine-readable formats', description: 'Tab-separated values for Unix tools (cut, awk, grep, xargs)' },
  json:  { section: 'Machine-readable formats', description: 'JSON format for programmatic access and AI agents' },
  yaml:  { section: 'Machine-readable formats', description: 'YAML format for human-friendly structured data' },
} as const;

/**
 * Add the standard `-o, --output <format>` option to a command.
 * @param cmd - The Commander command to add the option to.
 * @param extra - Additional format names beyond the defaults (table, tsv, json, yaml).
 * @returns The command (for chaining).
 */
export function withOutputOption(cmd: Command, extra?: string[]): Command {
  const formats = ['table', 'tsv', 'json', 'yaml', ...(extra ?? [])];
  return cmd.option("-o, --output <format>", `Output format: ${formats.join(', ')}`, "table");
}
