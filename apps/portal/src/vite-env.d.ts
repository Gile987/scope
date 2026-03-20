/// <reference types="vite/client" />

// Build-time version info (injected via vite.config.ts define)
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_BRANCH__: string;

interface ImportMetaEnv {
  /** Show the Pass@k metrics table on the Statistics page (default: hidden) */
  readonly VITE_SHOW_PASS_AT_K?: string;
  /** Enable v1 (free-text prompts) single shot criteria type in job submission (default: false) */
  readonly VITE_ENABLE_V1_SINGLE_SHOT_CRITERIA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
