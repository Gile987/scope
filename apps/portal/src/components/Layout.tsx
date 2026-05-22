// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo } from "react";
import { Link, useLocation, Outlet, matchPath } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Activity,
  Plus,
  List,
  FlaskConical,
  BarChart3,
  Tags,
  FileText,
  KeyRound,
  Bot,
  Server,
  Lightbulb,
  Cpu,
  MessageSquareText,
  Settings,
  Menu,
  BookOpen,
  GitBranch,
  Plug,
  Puzzle,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  { to: "/insights", label: "Insights", icon: Lightbulb },
  { to: "/criteria", label: "Criteria", icon: FlaskConical },
  { to: "/prompt-features", label: "Features", icon: Tags },
  { to: "/profiles", label: "Profiles", icon: SlidersHorizontal, featureKey: "profiles" },
  { to: "/agents", label: "Agents", icon: Bot, featureKey: "agents" },
  { to: "/models", label: "Models", icon: Cpu, featureKey: "models" },
  { to: "/mcp-servers", label: "MCP", icon: Server, featureKey: "mcp" },
  { to: "/skills", label: "Skills", icon: BookOpen, featureKey: "skills" },
  { to: "/extensions", label: "Extensions", icon: Puzzle, featureKey: "extensions" },
  { to: "/secrets", label: "Secrets", icon: KeyRound, featureKey: "tokens" },
];

/**
 * Routes that opt-in to the full-bleed list/detail layout (no `container`
 * max-width or vertical padding). The list page must render `<ListLayout>`.
 */
const FULL_BLEED_ROUTE_PATTERNS = [
  "/prompt-features",
  "/prompt-features/:id",
  "/agents",
  "/agents/:id",
  "/models",
  "/models/:id",
  "/runs",
  "/runs/:id/preview",
];

interface SidebarIconLinkProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  external?: boolean;
}

function SidebarIconLink({ to, label, icon: Icon, active, external }: SidebarIconLinkProps) {
  const className = cn(
    "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
    active
      ? "bg-accent text-foreground"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
  const content = (
    <>
      {active && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary"
          aria-hidden
        />
      )}
      <Icon className="h-5 w-5" />
    </>
  );
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        {external ? (
          <a
            href={to}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
            aria-label={label}
          >
            {content}
          </a>
        ) : (
          <Link to={to} className={className} aria-label={label}>
            {content}
          </Link>
        )}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Layout() {
  const location = useLocation();
  const { isFeatureEnabled } = useFeatureFlags();
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleNavItems = navItems.filter(
    (item) => !item.featureKey || isFeatureEnabled(item.featureKey),
  );

  const isFullBleed = useMemo(
    () =>
      FULL_BLEED_ROUTE_PATTERNS.some((pattern) =>
        matchPath({ path: pattern, end: true }, location.pathname),
      ),
    [location.pathname],
  );

  const adminActive = location.pathname === "/admin";

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
      <div
        className={cn(
          "flex flex-col bg-background",
          isFullBleed ? "h-screen overflow-hidden" : "min-h-screen",
        )}
      >
        {/* Top header — full width, centered logo */}
        <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center justify-center border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Link to="/" className="flex items-center gap-2 font-bold" aria-label="Scope home">
            <Activity className="h-5 w-5" />
            <span>Scope</span>
          </Link>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar — icon-only */}
          <aside
            className="hidden w-14 shrink-0 flex-col items-center border-r border-border/60 bg-card/40 sm:flex"
            aria-label="Primary navigation"
          >
            {/* Primary nav (scrollable when overflowing) */}
            <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
              {visibleNavItems.map((item) => {
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <SidebarIconLink
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    active={isActive}
                  />
                );
              })}
            </nav>

            {/* Footer: API docs + Admin */}
            <div className="flex w-full flex-col items-center gap-1 border-t border-border/60 py-3">
              <SidebarIconLink
                to="/api-docs"
                label="API Documentation"
                icon={Plug}
                active={false}
                external
              />
              <SidebarIconLink
                to="/admin"
                label="Admin"
                icon={Settings}
                active={adminActive}
              />
            </div>
          </aside>

          {/* Main column (mobile header + content + version footer) */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Mobile nav bar (hamburger only, logo lives in top header) */}
            <div className="flex h-10 items-center border-b border-border/60 bg-background/95 px-2 backdrop-blur sm:hidden">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon">
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
                              : "text-muted-foreground",
                          )}
                        >
                          <item.icon className="h-4 w-4" />
                          {item.label}
                        </Link>
                      );
                    })}
                    <div className="my-2 h-px bg-border/60" />
                    <a
                      href="/api-docs"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Plug className="h-4 w-4" />
                      API Documentation
                    </a>
                    <Link
                      to="/admin"
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                        adminActive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <Settings className="h-4 w-4" />
                      Admin
                    </Link>
                  </nav>
                </SheetContent>
              </Sheet>
            </div>

            {/* Main content */}
            <main
              className={cn(
                "flex-1 min-h-0",
                isFullBleed ? "flex flex-col" : "container py-6",
              )}
            >
              <Outlet />
            </main>

            {/* Version footer — hidden in full-bleed mode */}
            {!isFullBleed && <VersionFooter />}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
