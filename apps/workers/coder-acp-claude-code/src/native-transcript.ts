// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers to locate and copy the native session transcript that the
 * `@anthropic-ai/claude-agent-sdk` (bundled with `claude-agent-acp`) writes
 * for every session.
 *
 * Path layout (verified against `cli.js` of `@anthropic-ai/claude-agent-sdk`
 * v0.2.112 — the version we currently ship):
 *
 *   ${CLAUDE_CONFIG_DIR ?? ${HOME}/.claude}/projects/<sanitized-cwd>/<sessionId>.jsonl
 *
 * The cwd sanitiser replaces every non `[a-zA-Z0-9]` character with `-` and
 * truncates the result if it exceeds `CLAUDE_NATIVE_CWD_MAX_LENGTH` (the
 * upstream bundle's `CY1` constant). The SDK does not currently publish that
 * limit; we mirror the implementation conservatively at 100 characters which
 * is the documented default. If the upstream SDK changes its cap we may need
 * to bump this — the worker logs the path it looked for so the mismatch is
 * easy to detect.
 */

import { copyFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Max length of the sanitised cwd segment. Mirrors the SDK's internal cap. */
export const CLAUDE_NATIVE_CWD_MAX_LENGTH = 100;

/** Sanitise a cwd into the form the Claude Agent SDK uses for its projects/ key. */
export function sanitiseCwdForClaudeNative(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= CLAUDE_NATIVE_CWD_MAX_LENGTH
    ? slug
    : slug.slice(0, CLAUDE_NATIVE_CWD_MAX_LENGTH);
}

/** Compute the absolute path the SDK is expected to write the transcript to. */
export function nativeTranscriptPath(opts: { sessionId: string; cwd: string; home?: string }): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(opts.home ?? homedir(), ".claude");
  return join(base, "projects", sanitiseCwdForClaudeNative(opts.cwd), `${opts.sessionId}.jsonl`);
}

/**
 * Copy the native transcript into the artifacts dir if it exists. Returns the
 * destination path on success, `undefined` if the source file is missing
 * (logged via `onLog`). Other errors propagate.
 */
export async function copyNativeTranscriptIfPresent(opts: {
  sessionId: string;
  cwd: string;
  destination: string;
  onLog?: (msg: string) => void;
}): Promise<string | undefined> {
  const src = nativeTranscriptPath({ sessionId: opts.sessionId, cwd: opts.cwd });
  try {
    await stat(src);
  } catch {
    opts.onLog?.(`[claude-native] transcript not found at ${src}`);
    return undefined;
  }
  await copyFile(src, opts.destination);
  return opts.destination;
}
