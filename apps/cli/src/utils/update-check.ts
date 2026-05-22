// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Non-blocking check for newer CLI versions on GitHub Releases.
 * Starts the check in the background and returns a flush function
 * that should be awaited after the command completes to print the notification.
 * Suppressed by SCOPE_NO_UPDATE_CHECK=1 environment variable.
 * Checks at most once per hour (cooldown stored in ~/.config/scope/update-check.json).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CONFIG_DIR = join(homedir(), ".config", "scope");
const STATE_FILE = join(CONFIG_DIR, "update-check.json");

function shouldCheck(): boolean {
  try {
    if (!existsSync(STATE_FILE)) return true;
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    const lastCheck = state.lastCheck ?? 0;
    return Date.now() - lastCheck >= UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function recordCheck(): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify({ lastCheck: Date.now() }) + "\n");
  } catch {
    // Best-effort — don't fail if we can't write state
  }
}

/**
 * Starts the update check in the background.
 * Returns a function that resolves with the update message (if any).
 * Also registers a process 'exit' handler to print the message even if
 * Commander calls process.exit() before the caller can await.
 */
export function checkForUpdates(currentVersion: string): () => Promise<void> {
  if (process.env.SCOPE_NO_UPDATE_CHECK === "1") return async () => {};
  if (!shouldCheck()) return async () => {};

  let message: string | undefined;
  const pending = checkLatestVersion(currentVersion).then((msg) => {
    message = msg;
  });

  // Print on exit even if process.exit() is called (e.g., --help, --version)
  process.on("exit", () => {
    if (message) process.stderr.write(message);
  });

  return async () => {
    await pending;
    // Print and clear so the exit handler doesn't double-print
    if (message) {
      process.stderr.write(message);
      message = undefined;
    }
  };
}

export const RELEASES_REPO = "growth-ecosystems/scope-doc";

export const RELEASES_URL =
  process.env.SCOPE_RELEASES_URL ||
  `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

/**
 * Fetch the latest released CLI version using the `gh` CLI.
 * Falls back to the GitHub REST API if `gh` is unavailable.
 * Returns the version string (without leading "v") or undefined on failure.
 * Timeout defaults to 5000ms but can be overridden (background check uses 2000ms).
 */
export async function fetchLatestVersion(timeoutMs = 5000): Promise<string | undefined> {
  // Skip gh CLI when a custom SCOPE_RELEASES_URL is set (e.g. in tests)
  if (!process.env.SCOPE_RELEASES_URL) {
    // Prefer gh CLI — it handles EMU/private repo auth natively
    try {
      const tag = execSync(
        `gh release view --repo ${RELEASES_REPO} --json tagName -q '.tagName'`,
        { encoding: "utf-8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      const version = tag.replace(/^v/, "");
      if (semver.valid(version)) return version;
    } catch {
      // gh not available or failed — fall through to REST API
    }
  }

  // Fallback: direct API call (works when GH_TOKEN is set)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) return undefined;

    const data = (await res.json()) as { tag_name?: string };
    if (!data.tag_name) return undefined;

    const latest = data.tag_name.replace(/^v/, "");
    return semver.valid(latest) ? latest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLatestVersion(currentVersion: string): Promise<string | undefined> {
  try {
    const latest = await fetchLatestVersion(2000);
    if (latest && semver.gt(latest, currentVersion)) {
      return (
        `\n  A newer version of scope is available: ${latest} (current: ${currentVersion})\n` +
        `  Run: scope update\n\n`
      );
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    recordCheck();
  }
}
