// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from 'commander';
import { styleText } from 'node:util';

/** Output format definition for help text generation */
export interface OutputFormatDef {
  section: string;
  description: string;
}

/**
 * Generate a help text block documenting available output formats.
 * Appended to the main program --help via addHelpText('after', ...).
 */
export function generateOutputFormatsHelp(
  formats: Record<string, OutputFormatDef>,
): string {
  const sections = new Map<string, Array<{ name: string; description: string }>>();
  for (const [name, def] of Object.entries(formats)) {
    if (!sections.has(def.section)) sections.set(def.section, []);
    sections.get(def.section)!.push({ name, description: def.description });
  }

  let output = '\n' + styleText('bold', 'Output Formats (-o, --output):') + '\n';
  for (const [section, items] of sections) {
    output += '\n  ' + styleText('italic', section) + '\n';
    for (const item of items) {
      output += `    ${styleText('cyan', item.name.padEnd(12))}  ${item.description}\n`;
    }
  }
  return output;
}

/** Environment variable definition for help text generation */
export interface EnvVarDef {
  description: string;
  default?: string;
}

/**
 * Generate a help text block documenting environment variables read by the CLI.
 * Appended to the main program --help via addHelpText('after', ...).
 */
export function generateEnvVarsHelp(
  envVars: Record<string, EnvVarDef>,
): string {
  const entries = Object.entries(envVars);
  const nameWidth = Math.max(...entries.map(([name]) => name.length));

  let output = '\n' + styleText('bold', 'Environment Variables:') + '\n';
  for (const [name, def] of entries) {
    output += `  ${styleText('cyan', name.padEnd(nameWidth))}  ${def.description}`;
    if (def.default !== undefined) {
      output += ` ${styleText('italic', `(default: ${def.default})`)}`;
    }
    output += '\n';
  }
  output += '\n  ' + styleText('italic', 'Variables are also loaded from a .env file in the current directory.') + '\n';
  return output;
}

/**
 * Recursively collect all commands and subcommands from a Commander program
 */
function getAllCommands(cmd: Command, prefix = ''): Array<{ name: string; description: string; args: string[]; options: string[] }> {
  const commands: Array<{ name: string; description: string; args: string[]; options: string[] }> = [];

  for (const subCmd of cmd.commands) {
    const fullName = prefix ? `${prefix} ${subCmd.name()}` : subCmd.name();
    const options = subCmd.options.map(opt => `${opt.flags} - ${opt.description}`);
    const args = subCmd.registeredArguments.map(
      (arg) => `<${arg.name()}>${arg.required ? '' : '?'} - ${arg.description}`
    );

    commands.push({
      name: fullName,
      description: subCmd.description(),
      args,
      options,
    });

    // Recursively collect subcommands
    commands.push(...getAllCommands(subCmd, fullName));
  }

  return commands;
}

/**
 * Configure Commander program with enhanced help formatting for AI agents.
 * Displays all commands, arguments, and options in a comprehensive, parseable format.
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

    // Custom formatHelp to show all commands at once — optimized for coding agents
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);

      let output = '';

      // Title and description
      if (cmd.description()) {
        output += styleText('bold', cmd.description()) + '\n\n';
      }

      // Usage
      output += styleText('bold', 'Usage:') + '\n';
      output += '  ' + helper.commandUsage(cmd) + '\n\n';

      // Global options
      if (cmd.options.length > 0) {
        output += styleText('bold', 'Global Options:') + '\n';
        for (const option of cmd.options) {
          const term = helper.optionTerm(option);
          const desc = helper.optionDescription(option);
          output += '  ' + styleText('green', term.padEnd(termWidth)) + '  ' + desc + '\n';
        }
        output += '\n';
      }

      // All commands with their arguments and options
      const allCommands = getAllCommands(cmd);
      if (allCommands.length > 0) {
        output += styleText('bold', 'All Commands:') + '\n';

        let lastTopLevelCommand = '';
        for (const command of allCommands) {
          const topLevelCommand = command.name.split(' ')[0];

          if (lastTopLevelCommand && lastTopLevelCommand !== topLevelCommand) {
            output += '\n';
          }
          lastTopLevelCommand = topLevelCommand;

          output += '  ' + styleText('cyan', command.name.padEnd(termWidth)) + '  ' + styleText('magenta', command.description) + '\n';

          // Arguments
          for (const arg of command.args) {
            output += '    ' + styleText('yellow', arg) + '\n';
          }

          // Options
          for (const opt of command.options) {
            output += '    ' + styleText('green', opt) + '\n';
          }
        }
        output += '\n';
      }

      return output;
    },
  });
}
