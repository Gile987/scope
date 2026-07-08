/// <reference types="vite/client" />

// Build-time version info (injected via vite.config.ts define)
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_BRANCH__: string;

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Statistics page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Runtime configuration injected via /config.js before the app boots. */
interface ScopeRuntimeConfig {
  /** Base URL for the public docs site (no trailing slash required). */
  docsBaseUrl?: string;
}

interface Window {
  __SCOPE_CONFIG__?: ScopeRuntimeConfig;
}
