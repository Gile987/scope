// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Standardized output format for version checkers.
 *
 * All version-checker packages under `apps/version-checkers/` MUST output
 * JSON conforming to this shape.  The unified `check-versions.yml` GitHub
 * Actions workflow relies on the `components[]` array to generate issue
 * titles, bodies, and dedup logic generically — no per-worker parsing.
 *
 * Each checker defines its own copy of these interfaces (to avoid pulling
 * in the heavy `shared` dependency tree).  This file is the canonical
 * reference that all copies must stay in sync with.
 */

/**
 * A single software component whose version is tracked.
 */
export interface ComponentVersionInfo {
  /** Human-readable component name, e.g. "@github/copilot" or "VS Code". */
  name: string;
  /** Environment variable in `versions.env` that pins this component. */
  envVar: string;
  /** Currently pinned version string. */
  current: string;
  /** Latest available version string. */
  latest: string;
  /** URL to the component's release page or package registry. */
  link: string;
}

/**
 * Result emitted by every version checker.
 */
export interface CheckResult {
  /** Worker directory name, e.g. "coder-acp-copilot". */
  worker: string;
  /** Repo-relative path to the worker's `versions.env` file. */
  versionsEnvPath: string;
  /** `true` when at least one component has current ≠ latest. */
  hasUpdates: boolean;
  /** One entry per tracked component. */
  components: ComponentVersionInfo[];
}
