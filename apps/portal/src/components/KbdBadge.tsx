// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { cn } from "@/lib/utils";
import { isMac } from "@/hooks/useCommandEnter";

interface KbdBadgeProps {
  className?: string;
}

/**
 * Small keyboard badge showing the platform-appropriate shortcut
 * for "Cmd+Enter" (Mac) or "Ctrl+Enter" (Windows/Linux).
 *
 * Designed to sit inside a `<Button>` after the label text.
 */
export function KbdBadge({ className }: KbdBadgeProps) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex items-center rounded border border-current/20 px-1 font-sans text-[10px] font-medium opacity-60",
        className,
      )}
    >
      {isMac ? "⌘↵" : "Ctrl↵"}
    </kbd>
  );
}
