/// <reference types="vite/client" />

// Build-time version info (injected via vite.config.ts define)
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_BRANCH__: string;

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Statistics page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
  /** Microsoft Entra authority, e.g. https://login.microsoftonline.com/common */
  readonly VITE_AUTH_AUTHORITY?: string;
  /** Public Portal/CLI client app registration ID */
  readonly VITE_AUTH_CLIENT_ID?: string;
  /** Comma-separated scopes, e.g. api://<api-app-id>/access_as_user */
  readonly VITE_AUTH_SCOPES?: string;
  /** Expected API audience */
  readonly VITE_AUTH_AUDIENCE?: string;
  /** Comma-separated trusted authority hosts for non-public-cloud Entra-compatible IdPs */
  readonly VITE_AUTH_KNOWN_AUTHORITIES?: string;
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
