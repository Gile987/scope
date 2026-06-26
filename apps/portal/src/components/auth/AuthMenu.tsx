// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { LogOut, Shield, UserCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/auth/AuthContext";

export function AuthMenu() {
  const { user, isLoading, logout } = useAuth();

  if (isLoading || !user) {
    return (
      <Button variant="ghost" size="sm" className="gap-2 px-2" disabled>
        <UserCircle className="h-4 w-4" />
        <span className="hidden sm:inline">Loading account</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-2">
          <UserCircle className="h-4 w-4" />
          <span className="hidden max-w-36 truncate sm:inline">{user.name ?? user.email ?? user.id}</span>
          <Badge variant={user.role === "admin" ? "purple" : "secondary"}>{user.role}</Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-1">
          <span className="block truncate">{user.name ?? user.id}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {user.email ?? user.id}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Shield className="h-3.5 w-3.5" />
            {user.role} via {user.idp ?? "configured IdP"}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={logout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
