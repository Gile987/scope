// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode, useState, useEffect, useCallback } from "react";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ListLayoutProps {
  /** Page title (rendered above the table). */
  title: ReactNode;
  /** Page description (rendered under the title). */
  description?: ReactNode;
  /** Optional header action slot (e.g. "New" button). */
  actions?: ReactNode;
  /** Left filter rail content. Pass `null` to hide the rail entirely. */
  filterRail: ReactNode | null;
  /** Main listing content (table, pagination, etc). */
  children: ReactNode;
  /**
   * Right detail panel content. When `null` or `undefined` the panel is hidden
   * and the main area expands to fill the remaining width.
   */
  detail?: ReactNode;
  /** Persisted localStorage key for the rail collapsed state. */
  railStorageKey?: string;
  /** Width of the filter rail when expanded. */
  railWidth?: string;
  /** Width of the detail panel. */
  detailWidth?: string;
  className?: string;
}

const DEFAULT_RAIL_WIDTH = "260px";
const DEFAULT_DETAIL_WIDTH = "420px";

export function ListLayout({
  title,
  description,
  actions,
  filterRail,
  children,
  detail,
  railStorageKey,
  railWidth = DEFAULT_RAIL_WIDTH,
  detailWidth = DEFAULT_DETAIL_WIDTH,
  className,
}: ListLayoutProps) {
  const fullKey = railStorageKey ? `scope:list-layout:${railStorageKey}:rail-collapsed` : null;
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (!fullKey) return false;
    try {
      return localStorage.getItem(fullKey) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!fullKey) return;
    try {
      localStorage.setItem(fullKey, railCollapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [fullKey, railCollapsed]);

  const toggleRail = useCallback(() => setRailCollapsed((v) => !v), []);

  const detailVisible = detail !== null && detail !== undefined && detail !== false;
  const hasRail = filterRail !== null;

  return (
    <div className={cn("flex h-full min-h-0 w-full overflow-hidden", className)}>
      {/* Left filter rail */}
      {hasRail && (
        <aside
          className={cn(
            "shrink-0 border-r border-border/60 transition-[width] duration-200 ease-out",
            railCollapsed ? "w-0" : "",
          )}
          style={!railCollapsed ? { width: railWidth } : undefined}
          aria-hidden={railCollapsed}
        >
          <div
            className="h-full overflow-hidden"
            style={{ width: railWidth }}
          >
            {filterRail}
          </div>
        </aside>
      )}

      {/* Main column: header + content */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            {hasRail && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={toggleRail}
                aria-label={railCollapsed ? "Show filters" : "Hide filters"}
                title={railCollapsed ? "Show filters" : "Hide filters"}
              >
                {railCollapsed ? (
                  <PanelLeft className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
              {description && (
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </section>

      {/* Right detail panel */}
      {detailVisible && (
        <aside
          className="shrink-0 border-l border-border/60"
          style={{ width: detailWidth }}
        >
          {detail}
        </aside>
      )}
    </div>
  );
}
