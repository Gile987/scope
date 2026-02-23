// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link, useLocation, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Activity, Plus, List, FlaskConical, BarChart3, Tags, FileText, KeyRound, Bot, Server, Lightbulb, Cpu } from "lucide-react";
import { VersionFooter } from "./VersionFooter";

const navItems = [
  { to: "/statistics", label: "Statistics", icon: BarChart3 },
  { to: "/runs", label: "Runs", icon: List },
  { to: "/runs/new", label: "New Run", icon: Plus },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/insights", label: "Insights", icon: Lightbulb },
  { to: "/criteria", label: "Criteria", icon: FlaskConical },
  { to: "/prompt-features", label: "Features", icon: Tags },
  { to: "/tokens", label: "Tokens", icon: KeyRound },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/mcp-servers", label: "MCP", icon: Server },
];

export function Layout() {
  const location = useLocation();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <Link to="/" className="mr-6 flex items-center space-x-2">
            <Activity className="h-6 w-6" />
            <span className="hidden font-bold sm:inline-block">Scope MT</span>
          </Link>
          <nav className="flex items-center space-x-6 text-sm font-medium">
            {navItems.map((item) => {
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
