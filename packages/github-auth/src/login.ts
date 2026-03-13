// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// login.ts — Automated GitHub browser login with TOTP MFA
// =============================================================================

import { chromium, Browser } from "playwright";
import { createTOTP } from "./totp.js";

export interface LoginOptions {
  username: string;
  password: string;
  totpSecret: string;
  /** Run browser in headed mode (visible window). Default: false. */
  headed?: boolean;
  /** Keep the browser process alive after login. Default: false. */
  keepAlive?: boolean;
  /** Directory for Playwright video recording. When set, the login session is recorded. */
  videoDir?: string;
}

export interface LoginResult {
  /** Playwright storageState JSON string (cookies + localStorage). */
  storageState: string;
  /** Paths to recorded video files (only when videoDir is set). */
  videoFilePaths?: string[];
}

export interface LiveLoginResult extends LoginResult {
  /** The browser process kept alive for reuse (only when keepAlive: true). */
  browser: Browser;
}

const LOGIN_TIMEOUT_MS = 30_000;

/**
 * Perform an automated GitHub login using username/password + TOTP MFA.
 *
 * Returns the Playwright storageState JSON string containing the session cookies,
 * ready to be passed to other Playwright contexts or saved to disk.
 */
export async function loginAndCaptureCookies(opts: LoginOptions & { keepAlive: true }): Promise<LiveLoginResult>;
export async function loginAndCaptureCookies(opts: LoginOptions): Promise<LoginResult>;
export async function loginAndCaptureCookies(opts: LoginOptions): Promise<LoginResult | LiveLoginResult> {
  const totp = createTOTP(opts.totpSecret);

  const browser = await chromium.launch({ headless: !opts.headed });
  const contextOptions: Parameters<typeof browser['newContext']>[0] = {
    viewport: { width: 1920, height: 1080 },
  };
  if (opts.videoDir) {
    contextOptions.recordVideo = { dir: opts.videoDir, size: { width: 1920, height: 1080 } };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    // Step 1: Navigate to login page
    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });

    // Step 2: Fill in credentials and submit
    await page.fill("#login_field", opts.username);
    await page.fill("#password", opts.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS }),
      page.click('input[type="submit"], button[type="submit"]'),
    ]);

    // Step 3: Check for login error
    const errorBanner = page.locator(".js-flash-alert, #js-flash-container .flash-error");
    if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
      const errorText = await errorBanner.first().textContent();
      throw new Error(`GitHub login failed: ${errorText?.trim()}`);
    }

    // Step 4: Handle MFA if present
    const totpField = page.locator("#app_totp");
    if (await totpField.isVisible({ timeout: 5000 }).catch(() => false)) {
      const code = totp.generate();

      // GitHub auto-submits the TOTP form when all 6 digits are filled.
      // Start waiting for navigation before filling to avoid a race.
      const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
      await totpField.fill(code);
      await navPromise;

      // Check for TOTP error (wrong code — GitHub stays on the TOTP page)
      if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
        const errorText = await errorBanner.first().textContent();
        throw new Error(`TOTP verification failed: ${errorText?.trim()}`);
      }
    }

    // Step 5: Wait for session cookie to appear
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let sessionFound = false;
    while (Date.now() < deadline) {
      const cookies = await context.cookies();
      if (cookies.some((c) => c.name === "user_session" && c.domain === "github.com")) {
        sessionFound = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!sessionFound) {
      const url = page.url();
      const title = await page.title();
      const cookies = await context.cookies();
      const cookieNames = cookies.map((c) => c.name).join(", ");
      throw new Error(
        `Timed out waiting for session cookie.\n` +
        `  URL:     ${url}\n` +
        `  Title:   ${title}\n` +
        `  Cookies: ${cookieNames || "(none)"}\n` +
        `  Hint:    GitHub may be showing a device verification or recovery codes page.\n` +
        `           Re-run with headed=true to see what page the browser is on.`
      );
    }

    // Wait for the authenticated page to fully load so the video captures the result
    await page.waitForLoadState("load", { timeout: LOGIN_TIMEOUT_MS }).catch(() => {});

    // Step 6: Capture storage state as JSON string
    const storageState = JSON.stringify(await context.storageState());

    // Collect video paths before closing the context
    const videoFilePaths: string[] = [];
    if (opts.videoDir) {
      for (const p of context.pages()) {
        const video = p.video();
        if (video) {
          videoFilePaths.push(await video.path());
        }
      }
    }

    // Close the login context (cookies already extracted)
    await context.close();

    const videoPart = videoFilePaths.length > 0 ? { videoFilePaths } : {};

    if (opts.keepAlive) {
      return { storageState, browser, ...videoPart };
    }

    await browser.close();
    return { storageState, ...videoPart };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
