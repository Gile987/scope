// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useLocation, useNavigate, Outlet } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const tabs = [
  { value: "reports", label: "Reports", path: "/reports" },
  { value: "templates", label: "Templates", path: "/reports/templates" },
] as const;

function activeTab(pathname: string): string {
  // Check templates first (more specific prefix)
  if (pathname.startsWith("/reports/templates")) return "templates";
  return "reports";
}

export function ReportsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = activeTab(location.pathname);

  return (
    <div className="space-y-4">
      <Tabs value={current} onValueChange={(v) => {
        const tab = tabs.find((t) => t.value === v);
        if (tab) navigate(tab.path);
      }}>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
