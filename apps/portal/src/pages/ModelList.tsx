// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { Model } from "@/types";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Eye, Cpu, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function ModelList() {
  const { data: models = [], isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: () => api.listModels(),
  });

  // Filter state
  const [providerFilter, setProviderFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [searchQuery, setSearchQuery] = useState("");

  // Derive unique filter options from data
  const uniqueProviders = useMemo(
    () => [...new Set(models.map((m) => m.provider))].sort(),
    [models],
  );
  const uniqueAgents = useMemo(
    () => [...new Set(models.map((m) => m.agentId))].sort(),
    [models],
  );

  // Apply filters
  const filteredModels = useMemo(() => {
    return models.filter((m: Model) => {
      if (providerFilter !== "all" && m.provider !== providerFilter) return false;
      if (agentFilter !== "all" && m.agentId !== agentFilter) return false;
      if (statusFilter === "active" && m.disappearedAt) return false;
      if (statusFilter === "disappeared" && !m.disappearedAt) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!m.modelId.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [models, providerFilter, agentFilter, statusFilter, searchQuery]);

  // Summary counts
  const totalActive = models.filter((m) => !m.disappearedAt).length;
  const totalDisappeared = models.filter((m) => m.disappearedAt).length;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Models</h1>
          <p className="text-muted-foreground">
            {models.length} models ({totalActive} active, {totalDisappeared} disappeared)
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search model ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 w-[250px]"
          />
        </div>
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {uniqueProviders.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {uniqueAgents.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disappeared">Disappeared</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Models table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {models.length === 0
            ? "No models found. Models are discovered automatically by model scanners."
            : "No models match the current filters."}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>First Seen</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredModels.map((model: Model) => (
                <TableRow key={model.id} className={model.disappearedAt ? "opacity-60" : ""}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/models/${encodeURIComponent(model.id)}`} className="hover:underline flex items-center gap-1.5">
                      <Cpu className="h-3.5 w-3.5" />
                      {model.modelId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{model.provider}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link to={`/agents/${model.agentId}`} className="hover:underline text-xs">
                      {model.agentId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {model.disappearedAt
                      ? <Badge variant="secondary">Disappeared</Badge>
                      : <Badge variant="default">Active</Badge>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(model.firstSeenAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {model.disappearedAt
                      ? formatDate(model.disappearedAt)
                      : formatDate(model.lastSeenAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link to={`/models/${encodeURIComponent(model.id)}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
