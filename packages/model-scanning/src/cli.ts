// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared CLI argument parsing for model scanner apps.
 */

export interface ScannerCliOptions {
  /** If true, scan and print models but do not call the API. */
  dryRun: boolean;
  /** API base URL for non-dry-run mode. */
  apiUrl: string;
}

/**
 * Parse CLI arguments for a model scanner.
 *
 * Supports:
 *   --dry-run   Scan and print models as JSON, do not call the API.
 *   --api-url   Override the API base URL (env: API_URL, default: http://localhost:3100).
 */
export function parseScannerArgs(argv: string[] = process.argv): ScannerCliOptions {
  const args = argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const apiUrlIndex = args.indexOf("--api-url");
  const apiUrlArg = apiUrlIndex >= 0 ? args[apiUrlIndex + 1] : undefined;
  const apiUrl = apiUrlArg || process.env.API_URL || "http://localhost:3100";

  return { dryRun, apiUrl };
}
