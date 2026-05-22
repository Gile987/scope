// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  DataTable,
  Pagination,
  useListUrlState,
  type DataTableColumn,
} from "@/components/list-layout";
import { formatDate, formatId, formatDuration, truncate } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, RunStatus, RunOutcome } from "@/types";

const FILTER_KEYS = ["worker", "status", "outcome", "taskPromptId", "submissionId", "criteria"] as const;

export function RunsList() {
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();

  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });

  // Cursor pagination — keep a stack of cursors that map a virtual page number
  // to an `after` cursor (page 1 = no cursor, page 2 = stack[0], …).
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  // Reset stack whenever filters or page size change.
  const filtersKey = useMemo(
    () =>
      JSON.stringify({
        search: state.search,
        worker: state.getFilterList("worker"),
        status: state.getFilterList("status"),
        outcome: state.getFilterList("outcome"),
        taskPromptId: state.getFilter("taskPromptId"),
        submissionId: state.getFilter("submissionId"),
        criteria: state.getFilter("criteria"),
        pageSize: state.pageSize,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.search,
      state.pageSize,
      // serialized filters captured via filtersKey
      searchParams.toString(),
    ],
  );
  useEffect(() => {
    setCursorStack([undefined]);
    if (state.page !== 1) state.setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const workers = state.getFilterList("worker");
  const statuses = state.getFilterList("status");
  const outcomes = state.getFilterList("outcome");
  const taskPromptId = state.getFilter("taskPromptId") ?? undefined;
  const submissionId = state.getFilter("submissionId") ?? undefined;
  const criteria = state.getFilter("criteria") ?? undefined;

  const currentCursor = cursorStack[state.page - 1];

  // The server only accepts a single value per filter; if multiple are selected
  // we fetch the broader set and filter client-side.
  const serverWorker = workers.length === 1 ? workers[0] : undefined;
  const serverStatus = statuses.length === 1 ? statuses[0] : undefined;
  const serverOutcome = outcomes.length === 1 ? outcomes[0] : undefined;

  const { data: runsResponse, isLoading, isRefetching } = useQuery({
    queryKey: ["runs", serverWorker, serverStatus, serverOutcome, taskPromptId, submissionId, criteria, state.pageSize, currentCursor],
    queryFn: () =>
      api.listRuns({
        worker: serverWorker,
        status: serverStatus,
        outcome: serverOutcome,
        taskPromptId,
        submissionId,
        criteria,
        limit: state.pageSize,
        after: currentCursor,
      }),
    refetchInterval: 10_000,
  });

  const allRuns = runsResponse?.data ?? [];
  const cursors = runsResponse?.cursors ?? { next: null, prev: null };
  const estimatedTotal = runsResponse?.estimatedTotal;

  // Client-side filtering for multi-value selections + search.
  const filteredRuns = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    return allRuns.filter((r) => {
      if (workers.length > 1 && !workers.includes(r.workerType)) return false;
      if (statuses.length > 1) {
        const s = r.run?.status;
        if (!s || !statuses.includes(s)) return false;
      }
      if (outcomes.length > 1) {
        const o = r.run?.outcome;
        if (!o || !outcomes.includes(o)) return false;
      }
      if (q) {
        const hay =
          (r._id + " " + (r.scenario?.task ?? "") + " " + (r.model ?? "") + " " + (r.workerType ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRuns, workers, statuses, outcomes, state.search]);

  const sortedRuns = useMemo(() => {
    if (!state.sort) return filteredRuns;
    const out = [...filteredRuns];
    out.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") out.reverse();
    return out;
  }, [filteredRuns, state.sort, state.sortDir]);

  const handlePageChange = useCallback(
    (next: number) => {
      if (next === state.page) return;
      if (next === state.page + 1) {
        if (!cursors.next) return;
        setCursorStack((prev) => {
          const copy = [...prev];
          copy[next - 1] = cursors.next ?? undefined;
          return copy;
        });
        state.setPage(next);
      } else if (next === state.page - 1) {
        state.setPage(next);
      } else if (next === 1) {
        state.setPage(1);
      }
    },
    [state, cursors.next],
  );

  // Filter options derived from current page (counts reflect this page only).
  const workerOptions = useMemo(
    () =>
      WORKER_TYPES.map((w) => ({
        value: w,
        label: w,
        count: allRuns.filter((r) => r.workerType === w).length,
      })),
    [allRuns],
  );

  const statusOptions = useMemo(
    () =>
      STATUS_LIST.map((s) => ({
        value: s,
        label: s,
        count: allRuns.filter((r) => r.run?.status === s).length,
      })),
    [allRuns],
  );

  const outcomeOptions = useMemo(
    () =>
      OUTCOME_LIST.map((o) => ({
        value: o,
        label: o,
        count: allRuns.filter((r) => r.run?.outcome === o).length,
      })),
    [allRuns],
  );

  const columns: DataTableColumn<Run>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      cell: (r) => <span className="font-mono text-xs">{formatId(r._id)}</span>,
    },
    {
      id: "task",
      header: "Task",
      cell: (r) =>
        r.scenario?.task ? (
          <span className="text-sm" title={r.scenario.task}>
            {truncate(r.scenario.task, 60)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "worker",
      header: "Worker",
      sortable: true,
      width: "160px",
      cell: (r) => <Badge variant="outline" className="font-mono text-xs">{r.workerType}</Badge>,
    },
    {
      id: "model",
      header: "Model",
      width: "180px",
      cell: (r) =>
        r.model ? (
          <span className="font-mono text-xs">{r.model}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      sortable: true,
      width: "120px",
      cell: (r) => (r.run?.status ? <StatusBadge status={r.run.status} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "120px",
      cell: (r) => (r.run?.outcome ? <OutcomeBadge outcome={r.run.outcome} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "duration",
      header: "Duration",
      sortable: true,
      width: "100px",
      cell: (r) => {
        const start = r.run?.startedAt;
        const end = r.run?.finishedAt;
        if (!start || !end) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <span className="font-mono text-xs">
            {formatDuration(new Date(end).getTime() - new Date(start).getTime())}
          </span>
        );
      },
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>,
    },
  ];

  return (
    <ListLayout
      title="Runs"
      description={
        estimatedTotal != null
          ? `~${estimatedTotal.toLocaleString()} runs total`
          : "Manage and monitor benchmark runs"
      }
      railStorageKey="runs"
      actions={
        <Link to="/runs/new">
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> New Run
          </Button>
        </Link>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search runs…"
          refreshing={isRefetching}
          footer={
            <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
          }
        >
          <FilterSection title="Worker" storageKey="runs-worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={workers}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
            />
          </FilterSection>
          <FilterSection title="Status" storageKey="runs-status">
            <CheckboxFilterGroup
              options={statusOptions}
              selected={statuses}
              onToggle={(v) => state.toggleFilterValue("status", v)}
            />
          </FilterSection>
          <FilterSection title="Outcome" storageKey="runs-outcome">
            <CheckboxFilterGroup
              options={outcomeOptions}
              selected={outcomes}
              onToggle={(v) => state.toggleFilterValue("outcome", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      detail={detailOutlet}
    >
      <div className="flex flex-col gap-3">
        <DataTable
          items={sortedRuns}
          columns={columns}
          getRowId={(r) => r._id}
          activeId={activeId}
          onRowClick={(r) => navigate({ pathname: `/runs/${r._id}/preview`, search: window.location.search })}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          emptyState={
            state.hasActiveFilters
              ? "No runs match the current filters."
              : "No runs yet. Submit one with the New Run button."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={estimatedTotal}
          onPageChange={handlePageChange}
          onPageSizeChange={state.setPageSize}
          hasNext={!!cursors.next}
          hasPrev={state.page > 1}
          hideFirstLast
          itemLabel="runs"
        />
      </div>
    </ListLayout>
  );
}

function sortKey(r: Run, col: string): string | number {
  switch (col) {
    case "id":
      return r._id;
    case "worker":
      return r.workerType;
    case "status":
      return r.run?.status ?? "";
    case "duration": {
      const start = r.run?.startedAt;
      const end = r.run?.finishedAt;
      if (!start || !end) return 0;
      return new Date(end).getTime() - new Date(start).getTime();
    }
    case "created":
      return new Date(r.createdAt).getTime();
    default:
      return "";
  }
}

// Suppress unused warnings for re-exported types kept for callers.
export type { RunStatus, RunOutcome };
