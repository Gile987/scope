// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { program } from './index.js';

/** Recursively collect the command tree structure */
function commandTree(cmd: Command): Record<string, unknown> {
  const entry: Record<string, unknown> = {};

  const opts = cmd.options.map((o) => o.long ?? o.short).sort();
  if (opts.length > 0) entry.options = opts;

  const subs = cmd.commands as Command[];
  if (subs.length > 0) {
    entry.subcommands = Object.fromEntries(
      subs.map((c) => [c.name(), commandTree(c)]),
    );
  }

  return entry;
}

describe('CLI command registration', () => {
  it('full command tree matches snapshot', () => {
    const tree = Object.fromEntries(
      (program.commands as Command[]).map((c) => [c.name(), commandTree(c)]),
    );
    expect(tree).toMatchSnapshot();
  });
});
