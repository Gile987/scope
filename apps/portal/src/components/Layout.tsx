// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Activity, Plus, List, FlaskConical, BarChart3, Tags, FileText, FileCode, KeyRound, Bot, Server, Lightbulb, Cpu, MessageSquareText, Settings, Menu } from "lucide-react";
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
  { to: "/task-prompts", label: "Tasks", icon: MessageSquareText },
  { to: "/runs", label: "Runs", icon: List },
  { to: "/runs/new", label: "New Run", icon: Plus },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/report-templates", label: "Templates", icon: FileCode },
  { to: "/insights", label: "Insights", icon: Lightbulb },
  { to: "/criteria", label: "Criteria", icon: FlaskConical },
  { to: "/prompt-features", label: "Features", icon: Tags },
  { to: "/tokens", label: "Tokens", icon: KeyRound, featureKey: "tokens" },
  { to: "/agents", label: "Agents", icon: Bot, featureKey: "agents" },
  { to: "/models", label: "Models", icon: Cpu, featureKey: "models" },
  { to: "/mcp-servers", label: "MCP", icon: Server, featureKey: "mcp" },
];

export function Layout() {
  const location = useLocation();
  const { isFeatureEnabled } = useFeatureFlags();
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleNavItems = navItems.filter(
    (item) => !item.featureKey || isFeatureEnabled(item.featureKey)
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <Link to="/" className="mr-6 flex items-center space-x-2">
            <Activity className="h-6 w-6" />
            <span className="hidden font-bold sm:inline-block">Scope MT</span>
          </Link>

          {/* Desktop nav — hidden below lg */}
          <nav className="hidden lg:flex flex-1 items-center space-x-6 text-sm font-medium">
            {visibleNavItems.map((item) => {
              const isActive = location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
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

          {/* Spacer for mobile */}
          <div className="flex-1 lg:hidden" />

          {/* Admin gear icon - right aligned */}
          <Link
            to="/admin"
            className={cn(
              "p-2 transition-colors hover:text-foreground/80",
              location.pathname === "/admin" ? "text-foreground" : "text-foreground/60"
            )}
            title="Admin"
          >
            <Settings className="h-5 w-5" />
          </Link>

          {/* Mobile hamburger — visible below lg */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden ml-1">
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
