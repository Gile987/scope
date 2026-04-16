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
