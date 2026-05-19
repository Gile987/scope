// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Non-blocking check for newer CLI versions on GitHub Releases.
 * Prints a warning to stderr if a newer version is available.
 * Suppressed by SCOPE_NO_UPDATE_CHECK=1 environment variable.
 * Checks at most once per hour (cooldown stored in ~/.config/scope/update-check.json).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function checkForUpdates(currentVersion: string): void {
  if (process.env.SCOPE_NO_UPDATE_CHECK === "1") return;
  if (!shouldCheck()) return;

  // Fire-and-forget — never blocks CLI startup
  checkLatestVersion(currentVersion).catch(() => {
    // Silently ignore network errors
  });
}

const RELEASES_URL =
  process.env.SCOPE_RELEASES_URL ||
  "https://api.github.com/repos/growth-ecosystems/scope-doc/releases/latest";

async function checkLatestVersion(currentVersion: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    // Use GH_TOKEN or GITHUB_TOKEN for authenticated requests (avoids rate limits)
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) return;

    recordCheck();

    const data = (await res.json()) as { tag_name?: string };
    if (!data.tag_name) return;

    const latest = data.tag_name.replace(/^v/, "");
    if (isNewerVersion(latest, currentVersion)) {
      process.stderr.write(
        `\n  A newer version of scope is available: ${latest} (current: ${currentVersion})\n` +
          `  Run: gh release download --repo growth-ecosystems/scope-doc --pattern install.sh -O - | bash\n\n`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Returns true if `latest` is semantically newer than `current` */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
