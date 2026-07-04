// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { errorText } from "./style.js";

/** Parse KEY=VALUE strings into an object, exiting on bad format */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  return pairs.reduce((acc: Record<string, string>, pair: string) => {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      console.error(errorText(`Invalid env format: "${pair}". Expected KEY=VALUE`));
      process.exit(1);
    }
    acc[pair.substring(0, idx)] = pair.substring(idx + 1);
    return acc;
  }, {});
}

/** Parse name:value strings into header objects, exiting on bad format */
export function parseHeaderPairs(pairs: string[]): { name: string; value: string }[] {
  return pairs.map((h: string) => {
    const idx = h.indexOf(':');
    if (idx === -1) {
      console.error(errorText(`Invalid header format: "${h}". Expected name:value`));
      process.exit(1);
    }
    return { name: h.substring(0, idx).trim(), value: h.substring(idx + 1).trim() };
  });
}

/**
 * Parse repeatable `--option key=value` pairs into a generic per-worker agent
 * options bag. Values are coerced: `true`/`false` → boolean, a numeric string →
 * number, everything else stays a string. The API validates the resulting bag
 * against the selected worker's advertised option descriptors, so unknown keys
 * or wrong types are rejected server-side with a descriptive error.
 */
export function parseAgentOptionPairs(pairs: string[]): Record<string, unknown> {
  return pairs.reduce((acc: Record<string, unknown>, pair: string) => {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      console.error(errorText(`Invalid option format: "${pair}". Expected key=value (e.g. autopilot=true)`));
      process.exit(1);
    }
    const key = pair.substring(0, idx).trim();
    const raw = pair.substring(idx + 1).trim();
    if (!key) {
      console.error(errorText(`Invalid option format: "${pair}". Missing key before '='`));
      process.exit(1);
    }
    acc[key] = coerceOptionValue(raw);
    return acc;
  }, {});
}

/** Coerce a raw CLI option string into boolean | number | string. */
function coerceOptionValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Only treat as a number when it round-trips cleanly (avoids "1.2.3", "" etc.)
  if (raw !== "" && !Number.isNaN(Number(raw)) && String(Number(raw)) === raw) {
    return Number(raw);
  }
  return raw;
}
