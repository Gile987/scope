// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { McpServerDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Server } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  DataTable,
  Pagination,
  BulkActionBar,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";

const FILTER_KEYS = ["type"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "id", label: "Slug", required: true },
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
  { id: "endpoint", label: "URL / Command" },
  { id: "version", label: "Version" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function McpServerList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { slug: activeId } = useParams<{ slug?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "mcp-servers", defaultHidden: ["version"] });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const { data: servers = [], isLoading } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteMcpServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      toast.success("MCP server deleted");
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteMcpServer(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} MCP server${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const activeServers = useMemo(
    () => servers.filter((s: McpServerDocument) => !s.deletedAt),
    [servers],
  );

  const typeOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of activeServers) map.set(s.type, (map.get(s.type) ?? 0) + 1);
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value.toUpperCase(), count }));
  }, [activeServers]);

  const filteredServers = useMemo(() => {
    const types = state.getFilterList("type");
    const q = state.search.trim().toLowerCase();
    return activeServers.filter((s) => {
      if (types.length > 0 && !types.includes(s.type)) return false;
      if (q) {
        const blob = `${s._id} ${s.name}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeServers, state]);

  const sortedServers = useMemo(() => {
    if (!state.sort) return filteredServers;
    const sorted = [...filteredServers];
    sorted.sort((a, b) => {
      const av = mcpSortKey(a, state.sort!);
      const bv = mcpSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredServers, state.sort, state.sortDir]);

  const total = sortedServers.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedServers.slice(pageStart, pageStart + state.pageSize);

  const toggleRow = useCallback((id: Key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleAll = useCallback((ids: Key[]) => {
    setSelectedIds((prev) => {
      const stringIds = ids.map((id) => String(id));
      const allSelected = stringIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) for (const id of stringIds) next.delete(id);
      else for (const id of stringIds) next.add(id);
      return next;
    });
  }, []);

  const columns: DataTableColumn<McpServerDocument>[] = [
    {
      id: "id",
      header: "Slug",
      sortable: true,
      width: "160px",
      cell: (s) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
          {s._id}
        </span>
      ),
    },
    ...(!columnVisibility.isHidden("name") ? [{
      id: "name",
      header: "Name",
      sortable: true,
      cell: (s: McpServerDocument) => <span className="text-sm">{s.name}</span>,
    }] : []),
    ...(!columnVisibility.isHidden("type") ? [{
      id: "type",
      header: "Type",
      width: "90px",
      cell: (s: McpServerDocument) => (
        <Badge variant="outline" className="text-xs uppercase">{s.type}</Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("endpoint") ? [{
      id: "endpoint",
      header: "URL / Command",
      cell: (s: McpServerDocument) => (
        <span className="max-w-[300px] truncate text-xs text-muted-foreground font-mono block">
          {s.type === "stdio" ? s.command : s.url}
        </span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("version") ? [{
      id: "version",
      header: "Version",
      width: "100px",
      cell: (s: McpServerDocument) =>
        s.version ? (
          <span className="text-xs text-muted-foreground font-mono">{s.version}</span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        ),
    }] : []),
    ...(!columnVisibility.isHidden("created") ? [{
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (s: McpServerDocument) => (
        <span className="text-xs text-muted-foreground">{formatDate(s.createdAt)}</span>
      ),
    }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (s) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes the MCP server &quot;{s.name}&quot;. It will no longer be available for new runs.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(s._id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <ListLayout
      title="MCP Servers"
      description="Manage remote MCP servers available for benchmark runs"
      railStorageKey="mcp-servers"
      actions={
        <Button className="gap-1.5" onClick={() => navigate("/mcp-servers/new")}>
          <Plus className="h-4 w-4" /> Add Server
        </Button>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search servers…"
          footer={
            <div className="flex items-center justify-between gap-2">
              <ClearFiltersLink
                onClick={state.clearFilters}
                disabled={!state.hasActiveFilters}
              />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </div>
          }
        >
          <FilterSection title="Type" storageKey="mcp-servers-type">
            <CheckboxFilterGroup
              options={typeOptions}
              selected={state.getFilterList("type")}
              onToggle={(v) => state.toggleFilterValue("type", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_DEFS}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={columnVisibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : undefined
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/mcp-servers", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="server"
        >
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={bulkDeleteMutation.isPending || selectedIds.size === 0}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </BulkActionBar>

        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(s) => s._id}
          activeId={activeId}
          onRowClick={(s) =>
            navigate({ pathname: `/mcp-servers/${s._id}/preview`, search: window.location.search })
          }
          selection={{
            selectedIds,
            onToggle: toggleRow,
            onToggleAll: toggleAll,
          }}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={
            state.hasActiveFilters
              ? "No MCP servers match your filters"
              : "No MCP servers registered yet. Add one to make it available during run submission."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="servers"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} MCP server{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the selected MCP servers. They will no longer be available for new runs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setBulkDeleteOpen(false);
                bulkDeleteMutation.mutate([...selectedIds]);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListLayout>
  );
}

function mcpSortKey(s: McpServerDocument, col: string): string | number {
  switch (col) {
    case "id": return s._id;
    case "name": return s.name.toLowerCase();
    case "created": return new Date(s.createdAt).getTime();
    default: return "";
  }
}
