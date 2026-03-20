// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import { api } from "@/lib/api";

/**
 * Fetches the environment from the API and updates the favicon.
 * Integration → white favicon, production (default) → black favicon.
 */
export async function setFaviconForEnvironment(): Promise<void> {
  try {
    const { environment } = await api.getVersion();
    const favicon = environment === "integration" ? "/favicon-white.svg" : "/favicon-black.svg";
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (link) {
      link.href = favicon;
    }
  } catch {
    // Keep default favicon on error
  }
}

/** React hook that sets the favicon on mount based on the deployment environment. */
export function useFavicon() {
  useEffect(() => {
    setFaviconForEnvironment();
  }, []);
}
