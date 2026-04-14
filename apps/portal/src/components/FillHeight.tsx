// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FillHeightProps {
  /** Extra pixels to reserve below the container (e.g. for pagination) */
  bottomOffset?: number;
  className?: string;
  children: ReactNode;
}

/**
 * A container that stretches to fill the remaining viewport height below its
 * top edge, minus an optional `bottomOffset`. Content inside scrolls both
 * vertically and horizontally.
 *
 * Usage:
 * ```tsx
 * <FillHeight bottomOffset={48}>
 *   <Table>…</Table>
 * </FillHeight>
 * ```
 */
export function FillHeight({ bottomOffset = 0, className, children }: FillHeightProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const top = el.getBoundingClientRect().top;
      setMaxHeight(window.innerHeight - top - bottomOffset);
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [bottomOffset]);

  return (
    <div
      ref={ref}
      className={cn("overflow-auto", className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      {children}
    </div>
  );
}
