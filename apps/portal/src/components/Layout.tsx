// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Activity, Plus, List, FlaskConical, BarChart3, Tags, FileText, FileCode, KeyRound, Bot, Server, Lightbulb, Cpu, MessageSquareText, Settings, MoreHorizontal, Menu, BookOpen, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetTrigger, SheetTitle,
} from "@/components/ui/sheet";
import { VersionFooter } from "./VersionFooter";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When set, this nav item is only shown if the corresponding feature flag is enabled */
  featureKey?: string;
}

const navItems: NavItem[] = [
  { to: "/statistics", label: "Statistics", icon: BarChart3 },
  { to: "/criteria/mdp", label: "MDP", icon: GitBranch },
  { to: "/task-prompts", label: "Tasks", icon: MessageSquareText },
  { to: "/runs", label: "Runs", icon: List },
  { to: "/runs/new", label: "New Run", icon: Plus },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/report-templates", label: "Templates", icon: FileCode },
  { to: "/insights", label: "Insights", icon: Lightbulb },
  { to: "/criteria", label: "Criteria", icon: FlaskConical },
  { to: "/prompt-features", label: "Features", icon: Tags },
  { to: "/secrets", label: "Secrets", icon: KeyRound, featureKey: "tokens" },
  { to: "/agents", label: "Agents", icon: Bot, featureKey: "agents" },
  { to: "/models", label: "Models", icon: Cpu, featureKey: "models" },
  { to: "/mcp-servers", label: "MCP", icon: Server, featureKey: "mcp" },
  { to: "/skills", label: "Skills", icon: BookOpen, featureKey: "skills" },
];

/** Width reserved for the "More" overflow button (icon + padding) */
const MORE_BUTTON_WIDTH = 44;
/** Gap between nav items (matches space-x-5 = 1.25rem = 20px) */
const ITEM_GAP = 20;

export function Layout() {
  const location = useLocation();
  const { isFeatureEnabled } = useFeatureFlags();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Priority+ nav state
  const navContainerRef = useRef<HTMLDivElement>(null);
  const itemWidthsRef = useRef<number[]>([]);
  const [visibleCount, setVisibleCount] = useState<number | null>(null); // null = not measured yet

  const visibleNavItems = navItems.filter(
    (item) => !item.featureKey || isFeatureEnabled(item.featureKey)
  );

  // Measure individual item widths once they're rendered
  const measureItems = useCallback(() => {
    const container = navContainerRef.current;
    if (!container) return;
    const items = container.querySelectorAll<HTMLElement>("[data-nav-item]");
    itemWidthsRef.current = Array.from(items).map((el) => el.offsetWidth);
  }, []);

  // Recalculate how many items fit
  const recalculate = useCallback(() => {
    const container = navContainerRef.current;
    if (!container || itemWidthsRef.current.length === 0) return;

    const availableWidth = container.offsetWidth;
    const widths = itemWidthsRef.current;
    const total = widths.length;

    // Try fitting all items without the More button
    let usedWidth = 0;
    let fits = 0;
    for (let i = 0; i < total; i++) {
      const needed = usedWidth + widths[i] + (i > 0 ? ITEM_GAP : 0);
      if (needed <= availableWidth) {
        usedWidth = needed;
        fits++;
      } else {
        break;
      }
    }

    if (fits === total) {
      // Everything fits
      setVisibleCount(total);
      return;
    }

    // Not all fit — need More button, so recalculate with that reserved
    const availableWithMore = availableWidth - MORE_BUTTON_WIDTH - ITEM_GAP;
    usedWidth = 0;
    fits = 0;
    for (let i = 0; i < total; i++) {
      const needed = usedWidth + widths[i] + (i > 0 ? ITEM_GAP : 0);
      if (needed <= availableWithMore) {
        usedWidth = needed;
        fits++;
      } else {
        break;
      }
    }

    // Show at least 0 items (full overflow)
    setVisibleCount(Math.max(0, fits));
  }, []);

  // Measure on mount and when items change
  useEffect(() => {
    // Defer a frame to let items render at full width for measurement
    const frame = requestAnimationFrame(() => {
      measureItems();
      recalculate();
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleNavItems.length, measureItems, recalculate]);

  // ResizeObserver to react to container width changes
  useEffect(() => {
    const container = navContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      recalculate();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [recalculate]);

  // Close overflow dropdown when clicking outside
  useEffect(() => {
    if (!overflowOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-overflow-menu]")) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [overflowOpen]);

  // Close overflow when route changes
  useEffect(() => {
    setOverflowOpen(false);
  }, [location.pathname]);

  const effectiveVisible = visibleCount ?? visibleNavItems.length;
  const shownItems = visibleNavItems.slice(0, effectiveVisible);
  const overflowItems = visibleNavItems.slice(effectiveVisible);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <Link to="/" className="mr-4 flex items-center space-x-2 shrink-0">
            <Activity className="h-6 w-6" />
            <span className="hidden font-bold sm:inline-block">Scope</span>
          </Link>

          {/* Priority+ nav: measured container (overflow-hidden) + separate More button */}
          <div ref={navContainerRef} className="hidden sm:flex flex-1 items-center min-w-0 overflow-hidden">
            {visibleCount === null ? (
              // Measurement pass — render all items at natural width (clipped by overflow-hidden)
              <nav className="flex items-center space-x-5 text-sm font-medium whitespace-nowrap">
                {visibleNavItems.map((item) => (
                  <span key={item.to} data-nav-item className="flex items-center gap-1.5">
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </span>
                ))}
              </nav>
            ) : (
              // Normal render: only the items that fit
              <nav className="flex items-center space-x-5 text-sm font-medium whitespace-nowrap">
                {shownItems.map((item) => {
                  const isActive = location.pathname.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      data-nav-item
                      className={cn(
                        "flex items-center gap-1.5 transition-colors hover:text-foreground/80",
                        isActive ? "text-foreground" : "text-foreground/60"
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            )}
          </div>

          {/* "More" overflow button — sits OUTSIDE the overflow-hidden container so its dropdown is not clipped */}
          {visibleCount !== null && overflowItems.length > 0 && (
            <div className="relative hidden sm:block shrink-0 ml-5" data-overflow-menu>
              <button
                onClick={(e) => { e.stopPropagation(); setOverflowOpen((v) => !v); }}
                className={cn(
                  "flex items-center gap-1 text-sm font-medium transition-colors hover:text-foreground/80 text-foreground/60",
                  overflowItems.some((item) => location.pathname.startsWith(item.to)) && "text-foreground"
                )}
                aria-label="More navigation items"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {overflowOpen && (
                <div className="absolute top-full right-0 mt-2 w-48 rounded-md border bg-background shadow-lg py-1 z-50">
                  {overflowItems.map((item) => {
                    const isActive = location.pathname.startsWith(item.to);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                          isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Spacer on very small screens */}
          <div className="flex-1 sm:hidden" />

          {/* Admin gear icon */}
          <Link
            to="/admin"
            className={cn(
              "shrink-0 ml-4 p-2 transition-colors hover:text-foreground/80",
              location.pathname === "/admin" ? "text-foreground" : "text-foreground/60"
            )}
            title="Admin"
          >
            <Settings className="h-5 w-5" />
          </Link>

          {/* Mobile hamburger — visible on xs only (below sm) */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="sm:hidden ml-1 shrink-0">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 pt-10">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <nav className="flex flex-col space-y-1">
                {visibleNavItems.map((item) => {
                  const isActive = location.pathname.startsWith(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* Main content */}
      <main className="container flex-1 py-6">
        <Outlet />
      </main>

      {/* Version footer */}
      <VersionFooter />
    </div>
  );
}
