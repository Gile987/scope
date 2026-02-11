// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from 'commander';
import { styleText } from 'node:util';

/**
 * Configure Commander program with enhanced colored help formatting.
 * Mirrors the approach from the ca-geo reference CLI.
 */
export function configureHelp(program: Command): void {
  program.configureHelp({
    styleTitle: (str) => styleText('bold', str),
    styleCommandText: (str) => styleText('cyan', str),
    styleCommandDescription: (str) => styleText('magenta', str),
    styleDescriptionText: (str) => styleText('italic', str),
    styleOptionText: (str) => styleText('green', str),
    styleArgumentText: (str) => styleText('yellow', str),
    styleSubcommandText: (str) => styleText('blue', str),
  });
}
