// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// cookie-state.ts — Playwright storageState cookie validation
// =============================================================================

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
}

/**
 * Check whether a Playwright storageState JSON contains an expired
 * (or missing) GitHub `user_session` cookie.
 *
 * Returns `true` if the cookie state is expired or invalid — meaning
 * a fresh login is required.
 *
 * @param storageStateJson — Raw JSON string from Playwright's storageState()
 * @param nowSeconds — Current time in epoch seconds (default: Date.now()/1000).
 *                      Exposed for testing.
 */
export function isCookieStateExpired(
  storageStateJson: string,
  nowSeconds?: number,
): boolean {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  let state: PlaywrightStorageState;
  try {
    state = JSON.parse(storageStateJson);
  } catch {
    return true; // Unparseable → treat as expired
  }

  if (!Array.isArray(state.cookies)) {
    return true;
  }

  const session = state.cookies.find(
    (c) => c.name === "user_session" && c.domain === "github.com",
  );

  if (!session) {
    return true; // No session cookie → expired
  }

  // Playwright stores `expires` as epoch seconds (-1 means session cookie)
  if (session.expires === -1) {
    // Session cookie with no explicit expiry — treat as valid (browser manages lifetime)
    return false;
  }

  return session.expires <= now;
}
