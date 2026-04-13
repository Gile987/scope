// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";

export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

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
