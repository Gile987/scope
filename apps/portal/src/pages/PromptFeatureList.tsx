// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2 } from "lucide-react";
import { truncate } from "@/lib/utils";
import {
  ListLayout,
  FilterRail,
  ClearFiltersLink,
  DataTable,
  Pagination,
  useListUrlState,
  type DataTableColumn,
} from "@/components/list-layout";
import { HelpTooltip } from "@/components/HelpTooltip";
import type { PromptFeatureDocument } from "@/types";

export function PromptFeatureList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();

  const state = useListUrlState({ defaultPageSize: 25, filterKeys: [] });

  const { data: allFeatures = [], isLoading, isRefetching } = useQuery({
    queryKey: ["prompt-features", state.search],
    queryFn: () => api.listPromptFeatures(state.search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deletePromptFeature,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompt-features"] }),
  });

  // Sort + paginate client-side (server returns all matches).
  const sortedFeatures = useMemo(() => {
    const sorted = [...allFeatures];
    if (state.sort === "id") {
      sorted.sort((a, b) => a.id.localeCompare(b.id));
    } else if (state.sort === "prompt") {
      sorted.sort((a, b) => a.prompt.localeCompare(b.prompt));
    }
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [allFeatures, state.sort, state.sortDir]);

  const total = sortedFeatures.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedFeatures.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<PromptFeatureDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "240px",
      cell: (f) => (
        <Link
          to={`/prompt-features/${f.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-sm font-medium hover:underline"
        >
          {f.id}
        </Link>
      ),
    },
    {
      id: "prompt",
      header: "Prompt",
      sortable: true,
      cell: (f) => (
        <span className="text-sm text-muted-foreground">{truncate(f.prompt, 120)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right",
      cell: (f) => (
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
              <AlertDialogTitle>Delete prompt feature?</AlertDialogTitle>
              <AlertDialogDescription>
                This will delete <strong>{f.id}</strong>. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(f.id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
      title={
        <span className="inline-flex items-center gap-1.5">
          Prompt Features
          <HelpTooltip
            text="Detection rules that flag whether the agent's prompt or output uses specific capabilities (tools, agents, plans). Used for capability tracking and analytics."
            docs="promptFeatures"
            size="md"
          />
        </span>
      }
      description="Manage prompt feature detection"
      railStorageKey="prompt-features"
      actions={
        <Link to="/prompt-features/new">
          <Button className="gap-1.5" size="sm">
            <Plus className="h-4 w-4" /> New Feature
          </Button>
        </Link>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search prompt features…"
          refreshing={isRefetching}
          footer={
            <ClearFiltersLink
              onClick={state.clearFilters}
              disabled={!state.hasActiveFilters}
            />
          }
        >
          <div className="p-3 text-xs text-muted-foreground">
            Use the search above to filter by ID or prompt text.
          </div>
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() => navigate("/prompt-features")}
    >
      <div className="flex flex-col gap-3">
        <DataTable
          items={pageItems}
          columns={columns}
          getRowId={(f) => f.id}
          activeId={activeId}
          onRowClick={(f) => navigate(`/prompt-features/${f.id}`)}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          loadingRows={state.pageSize}
          emptyState={
            state.search ? "No prompt features match your search" : "No prompt features defined yet"
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="features"
        />
      </div>
    </ListLayout>
  );
}
