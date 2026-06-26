// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, Fragment } from "react";
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
import { ThemeToggle } from "./ThemeToggle";
import { AuthMenu } from "@/components/auth/AuthMenu";
import { useAuth } from "@/auth/AuthContext";
import type { Permission } from "@/auth/permissions";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When set, this nav item is only shown if the corresponding feature flag is enabled */
  featureKey?: string;
  /** Required permission(s) for showing this nav item. */
  permissions?: Permission | Permission[];
}

interface NavGroup {
  id: string;
  /** Human label shown in the mobile sheet and as the tooltip group hint. */
  label: string;
  items: NavItem[];
}

/**
 * Sidebar nav grouped by domain noun:
 *   Activity  — what happened (runs and their outputs)
 *   Library   — content you author (tasks, criteria, profiles, …)
 *   Resources — infra you wire up (agents, models, secrets, …)
 *
 * The dev-only MDP view is pinned separately at the bottom — it's a
 * diagnostic tool, not part of any of these groups.
 */
const navGroups: NavGroup[] = [
  {
    id: "activity",
    label: "Activity",
    items: [
      { to: "/runs", label: "Runs", icon: List, featureKey: "runs", permissions: "scope/run:read" },
      { to: "/statistics", label: "Statistics", icon: BarChart3, permissions: "scope/run:read" },
      { to: "/reports", label: "Reports", icon: FileText, featureKey: "reports", permissions: "scope/report:read" },
      { to: "/insights", label: "Insights", icon: Lightbulb, featureKey: "insights", permissions: "scope/insight:read" },
    ],
  },
  {
    id: "library",
    label: "Library",
    items: [
      { to: "/task-prompts", label: "Tasks", icon: MessageSquareText, featureKey: "task-prompts", permissions: "scope/task-prompt:read" },
      { to: "/criteria", label: "Criteria", icon: FlaskConical, featureKey: "criteria", permissions: "scope/criteria:read" },
      { to: "/prompt-features", label: "Features", icon: Tags, featureKey: "prompt-features", permissions: "scope/prompt-feature:read" },
      { to: "/profiles", label: "Profiles", icon: SlidersHorizontal, featureKey: "profiles", permissions: "scope/profile:read" },
      { to: "/skills", label: "Skills", icon: BookOpen, featureKey: "skills", permissions: "scope/skill:read" },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    items: [
      { to: "/agents", label: "Agents", icon: Bot, featureKey: "agents", permissions: "scope/agent:read" },
      { to: "/models", label: "Models", icon: Cpu, featureKey: "models", permissions: "scope/model:read" },
      { to: "/mcp-servers", label: "MCP", icon: Server, featureKey: "mcp", permissions: "scope/mcp-server:read" },
      { to: "/extensions", label: "Extensions", icon: Puzzle, featureKey: "extensions", permissions: "scope/extension:read" },
      { to: "/secrets", label: "Secrets", icon: KeyRound, featureKey: "tokens", permissions: "scope/user:admin" },
    ],
  },
];

// Dev/diagnostic — pinned at the bottom of the primary nav, kept out of the
// noun groups above so it doesn't compete with the day-to-day pages.
const devNavItems: NavItem[] = [
  { to: "/criteria/mdp", label: "MDP", icon: GitBranch, featureKey: "criteria", permissions: "scope/criteria:read" },
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
  "/task-prompts",
  "/criteria",
  "/insights",
  "/mcp-servers",
  "/skills",
  "/extensions",
  "/profiles",
  "/secrets/keys",
  "/secrets/accounts",
  "/reports",
  "/reports/templates",
];

interface SidebarIconLinkProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  external?: boolean;
  emphasized?: boolean;
}

function SidebarIconLink({
  to,
  label,
  icon: Icon,
  active,
  external,
  emphasized,
}: SidebarIconLinkProps) {
  const className = cn(
    "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
    emphasized
      ? "bg-action text-action-foreground shadow-sm hover:bg-action/90"
      : active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
  const content = (
    <>
      {active && !emphasized && (
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
  const { hasEveryPermission } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const filterByFeature = (items: NavItem[]) =>
    items.filter(
      (item) =>
        (!item.featureKey || isFeatureEnabled(item.featureKey)) &&
        hasEveryPermission(item.permissions),
    );

  const visibleGroups = useMemo(
    () =>
      navGroups
        .map((g) => ({ ...g, items: filterByFeature(g.items) }))
        .filter((g) => g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isFeatureEnabled, hasEveryPermission],
  );
  const visibleDevItems = filterByFeature(devNavItems);

  const isFullBleed = useMemo(
    () =>
      FULL_BLEED_ROUTE_PATTERNS.some((pattern) =>
        matchPath({ path: pattern, end: true }, location.pathname),
      ),
    [location.pathname],
  );

  const adminActive = location.pathname === "/admin";
  const canSubmitRun = isFeatureEnabled("submit-run") && hasEveryPermission("scope/run:write");
  const canViewApiDocs = hasEveryPermission("scope/user:admin");
  const canViewAdmin = isFeatureEnabled("admin") && hasEveryPermission("scope/user:admin");
  const hasFooterIcons = canViewApiDocs || canViewAdmin;

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
      <div
        className={cn(
          "flex flex-col bg-background",
          isFullBleed ? "h-screen overflow-hidden" : "min-h-screen",
        )}
      >
        {/* Top header — logo on the left, controls on the right */}
        <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center justify-between border-b border-border/60 bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Link to="/" className="flex items-center gap-2 font-bold" aria-label="Scope home">
            <Activity className="h-5 w-5 text-action" />
            <span>Scope</span>
          </Link>
          <div className="flex items-center gap-2">
            <AuthMenu />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar — icon-only, sticks below the top header */}
          <aside
            className="sticky top-12 z-30 hidden h-[calc(100vh-3rem)] w-14 shrink-0 flex-col items-center self-start overflow-y-auto overscroll-contain border-r border-border/60 bg-card/40 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex"
            aria-label="Primary navigation"
          >
            {/* Primary nav */}
            <nav className="flex w-full flex-col items-center gap-1 py-3">
              {/* New Run — emphasized primary CTA */}
              {canSubmitRun && (
                <>
                  <SidebarIconLink
                    to="/runs/new"
                    label="New Run"
                    icon={Plus}
                    active={location.pathname === "/runs/new"}
                    emphasized
                  />
                  <div className="my-1 h-px w-6 bg-border/60" aria-hidden />
                </>
              )}
              {visibleGroups.map((group, groupIdx) => (
                <Fragment key={group.id}>
                  {groupIdx > 0 && (
                    <div
                      className="my-1 h-px w-6 bg-border/60"
                      role="separator"
                      aria-label={group.label}
                    />
                  )}
                  {group.items.map((item) => {
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
                </Fragment>
              ))}
              {visibleDevItems.length > 0 && (
                <>
                  <div className="my-1 h-px w-6 bg-border/60" aria-hidden />
                  {visibleDevItems.map((item) => {
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
                </>
              )}
            </nav>

            {/* Footer: API docs + Admin — pinned to bottom when there's room, scrolls with content otherwise */}
            {hasFooterIcons && (
              <div className="mt-auto flex w-full flex-col items-center gap-1 border-t border-border/60 py-3">
                {canViewApiDocs && (
                  <SidebarIconLink
                    to="/api-docs"
                    label="API Documentation"
                    icon={Plug}
                    active={false}
                    external
                  />
                )}
                {canViewAdmin && (
                  <SidebarIconLink
                    to="/admin"
                    label="Admin"
                    icon={Settings}
                    active={adminActive}
                  />
                )}
              </div>
            )}
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
                    {canSubmitRun && (
                      <Link
                        to="/runs/new"
                        onClick={() => setMobileOpen(false)}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                          location.pathname === "/runs/new"
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <Plus className="h-4 w-4" />
                        New Run
                      </Link>
                    )}
                    {visibleGroups.map((group, groupIdx) => (
                      <Fragment key={group.id}>
                        <div
                          className={cn(
                            "px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground",
                            groupIdx > 0 && "pt-3",
                          )}
                        >
                          {group.label}
                        </div>
                        {group.items.map((item) => {
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
                      </Fragment>
                    ))}
                    {visibleDevItems.length > 0 && (
                      <>
                        <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Dev
                        </div>
                        {visibleDevItems.map((item) => {
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
                      </>
                    )}
                    {(canViewApiDocs || canViewAdmin) && (
                      <div className="my-2 h-px bg-border/60" />
                    )}
                    {canViewApiDocs && (
                      <a
                        href="/api-docs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <Plug className="h-4 w-4" />
                        API Documentation
                      </a>
                    )}
                    {canViewAdmin && (
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
                    )}
                  </nav>
                </SheetContent>
              </Sheet>
            </div>

            {/* Main content */}
            <main
              className={cn(
                "flex-1 min-h-0",
                isFullBleed ? "flex flex-col" : "w-full px-6 py-6 lg:px-8",
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
