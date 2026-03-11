// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useLocation, useNavigate, Outlet } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const tabs = [
  { value: "keys", label: "Keys", path: "/secrets/keys" },
  { value: "accounts", label: "Accounts", path: "/secrets/accounts" },
] as const;

function activeTab(pathname: string): string {
  for (const tab of tabs) {
    if (pathname.startsWith(tab.path)) return tab.value;
  }
  return "keys";
}

export function SecretsLayout() {
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
