// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { ProfileWithVersion } from "@/types";
import { WORKER_TYPES } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
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
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";

const FILTER_KEYS = ["worker"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "name", label: "Name", required: true },
  { id: "version", label: "Version" },
  { id: "worker", label: "Worker" },
  { id: "model", label: "Model" },
  { id: "mcpServers", label: "MCP Servers" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function ProfileList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailOutlet = useOutlet();
  const { profileId: activeId } = useParams<{ profileId?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({
    storageKey: "profiles",
    defaultHidden: ["mcpServers", "skills", "extensions"],
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("Profile deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete profile");
    },
  });

  const workerOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of profiles as ProfileWithVersion[]) {
      const wt = p.version?.workerType;
      if (wt) map.set(wt, (map.get(wt) ?? 0) + 1);
    }
    return WORKER_TYPES.map((wt) => ({
      value: wt,
      label: wt,
      count: map.get(wt) ?? 0,
    })).filter((o) => o.count > 0);
  }, [profiles]);

  const filteredProfiles = useMemo(() => {
    const workers = state.getFilterList("worker");
    const q = state.search.trim().toLowerCase();
    return (profiles as ProfileWithVersion[]).filter((p) => {
      if (workers.length > 0 && (!p.version?.workerType || !workers.includes(p.version.workerType))) {
        return false;
      }
      if (q) {
        const blob = `${p.name} ${p._id}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [profiles, state]);

  const sortedProfiles = useMemo(() => {
    if (!state.sort) return filteredProfiles;
    const sorted = [...filteredProfiles];
    sorted.sort((a, b) => {
      const av = profileSortKey(a, state.sort!);
      const bv = profileSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredProfiles, state.sort, state.sortDir]);

  const total = sortedProfiles.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedProfiles.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<ProfileWithVersion>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: (p) => <span className="font-medium">{p.name}</span>,
    },
    ...(!columnVisibility.isHidden("version") ? [{
      id: "version",
      header: "Version",
      width: "90px",
      cell: (p: ProfileWithVersion) => (
        <Badge variant="secondary">v{p.version.version}</Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("worker") ? [{
      id: "worker",
      header: "Worker",
      sortable: true,
      cell: (p: ProfileWithVersion) => (
        <span className="font-mono text-xs">{p.version.workerType}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("model") ? [{
      id: "model",
      header: "Model",
      width: "160px",
      cell: (p: ProfileWithVersion) => (
        <span className="font-mono text-xs">{p.version.model}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("mcpServers") ? [{
      id: "mcpServers",
      header: "MCP Servers",
      width: "110px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.mcpServers?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("skills") ? [{
      id: "skills",
      header: "Skills",
      width: "80px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.skillRevisions?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("extensions") ? [{
      id: "extensions",
      header: "Extensions",
      width: "100px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-sm">{p.version.extensions?.length ?? 0}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("created") ? [{
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (p: ProfileWithVersion) => (
        <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>
      ),
    }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (p) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete profile?</AlertDialogTitle>
              <AlertDialogDescription>
                This will soft-delete &quot;{p.name}&quot;. Existing runs referencing this profile will not be affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMutation.mutate(p._id);
                }}
              >
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
      title="Profiles"
      description="Saved run configurations for reproducible benchmarking"
      railStorageKey="profiles"
      actions={
        <Button className="gap-1.5" onClick={() => navigate("/profiles/new")}>
          <Plus className="h-4 w-4" /> New Profile
        </Button>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search profiles…"
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
          <FilterSection title="Worker" storageKey="profiles-worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={state.getFilterList("worker")}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
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
      onDetailClose={() => navigate("/profiles")}
    >
      <div className="flex flex-col gap-3">
        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(p) => p._id}
          activeId={activeId}
          onRowClick={(p) => navigate(`/profiles/${p._id}`)}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          emptyState={
            state.hasActiveFilters
              ? "No profiles match your filters"
              : "No profiles yet. Create one to get started."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="profiles"
        />
      </div>
    </ListLayout>
  );
}

function profileSortKey(p: ProfileWithVersion, col: string): string | number {
  switch (col) {
    case "name": return p.name.toLowerCase();
    case "worker": return (p.version?.workerType ?? "").toLowerCase();
    case "created": return new Date(p.createdAt).getTime();
    default: return "";
  }
}
