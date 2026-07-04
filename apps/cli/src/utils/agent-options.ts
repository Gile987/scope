// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Commander collector for a repeatable `--option key=value` flag. Accumulates
 * each occurrence into a string[] that {@link parseAgentOptionPairs} later turns
 * into a typed options bag.
 */
export function collectOption(val: string, previous: string[]): string[] {
  return previous.concat([val]);
}

/**
 * Static help text for the `--option` flag. Deliberately generic: the set of
 * options a worker accepts is advertised by the worker at registration, not
 * hardcoded here. Point users to `scope agent get` to discover them dynamically.
 */
export const AGENT_OPTION_HELP =
  " Options are per-worker; run `scope agent get --id <worker>` to list the options a worker advertises.";

/** Format an options bag for human-readable single-line display. */
export function formatAgentOptions(options: Record<string, unknown> | undefined): string {
  if (!options || Object.keys(options).length === 0) return "(none)";
  return Object.entries(options)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}
