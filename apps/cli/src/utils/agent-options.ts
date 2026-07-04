// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { WORKER_AGENT_OPTIONS } from "shared";

/**
 * Commander collector for a repeatable `--option key=value` flag. Accumulates
 * each occurrence into a string[] that {@link parseAgentOptionPairs} later turns
 * into a typed options bag.
 */
export function collectOption(val: string, previous: string[]): string[] {
  return previous.concat([val]);
}

/**
 * Static discoverability string listing every option the known workers advertise,
 * derived from the shared canonical {@link WORKER_AGENT_OPTIONS} map. Appended to
 * the `--option` flag help so `--help` shows what keys are accepted per worker.
 */
export const AGENT_OPTION_HELP: string = (() => {
  const parts: string[] = [];
  for (const [worker, descriptors] of Object.entries(WORKER_AGENT_OPTIONS)) {
    if (!descriptors || descriptors.length === 0) continue;
    const keys = descriptors
      .map((d) => `${d.key}=<${d.type}${d.enum ? `:${d.enum.join("|")}` : ""}>`)
      .join(", ");
    parts.push(`${worker}: ${keys}`);
  }
  if (parts.length === 0) return "";
  return ` Known worker options — ${parts.join("; ")}.`;
})();

/** Format an options bag for human-readable single-line display. */
export function formatAgentOptions(options: Record<string, unknown> | undefined): string {
  if (!options || Object.keys(options).length === 0) return "(none)";
  return Object.entries(options)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}
