/// <reference types="vite/client" />

// Build-time version info (injected via vite.config.ts define)
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Insights page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
