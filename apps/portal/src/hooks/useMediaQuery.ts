// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";

/**
 * Returns `true` when the given media query currently matches.
 *
 * Re-renders the consumer when the match state changes. SSR-safe — returns
 * `false` on the server and during the very first client render.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync once in case the value changed between the initial state and effect mount.
    setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Returns true when the viewport is below Tailwind's `lg` breakpoint (1024px). */
export function useIsCompactViewport(): boolean {
  return useMediaQuery("(max-width: 1023.98px)");
}
