/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Insights page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
