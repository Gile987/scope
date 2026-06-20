// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared constants and helpers for codebase archive uploads.
 *
 * The 1 MB cap is imposed by infrastructure, not application code: the portal
 * pod's nginx (`location /api/`) sets no `client_max_body_size`, so nginx's
 * default of 1 MB applies, and the AKS ingress defaults to 1 MB as well. An
 * upload larger than this is rejected with HTTP 413 before it reaches the API.
 * We validate client-side so the user gets a clear message instead of a raw 413.
 */
export const MAX_ARCHIVE_UPLOAD_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_UPLOAD_LABEL = "1 MB";

export const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".tar", ".zip", ".gz"];

export function isArchiveName(name: string): boolean {
  return ARCHIVE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate an archive file's type and size. Returns a human-readable error
 * message when the file is unsupported or too large, or `null` when it is fine.
 */
export function validateArchiveFile(file: File): string | null {
  if (!isArchiveName(file.name)) {
    return "Unsupported file. Use a .tar.gz, .tgz, .tar, or .zip archive.";
  }
  if (file.size > MAX_ARCHIVE_UPLOAD_BYTES) {
    return `Archive is ${formatBytes(file.size)} — exceeds the ${MAX_ARCHIVE_UPLOAD_LABEL} upload limit.`;
  }
  return null;
}
