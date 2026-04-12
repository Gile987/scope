// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Encode a query-string value, escaping only chars that break URL parsing. */
export function encodeQsValue(v: string): string {
  return v.replace(/[%&=+#\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Build a query string from non-undefined params. */
export function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v != null) parts.push(`${k}=${encodeQsValue(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
