// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import type { AccountDocument } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2 } from "lucide-react";
import { formatDate, formatId } from "@/lib/utils";
import { toast } from "sonner";
import { Link } from "react-router-dom";
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
  useListUrlState,
  useHiddenColumns,
  type DataTableColumn,
} from "@/components/list-layout";

const FILTER_KEYS = ["type"] as const;

const COLUMN_OPTIONS = [
  { id: "id", label: "ID", required: true },
  { id: "comment", label: "Comment" },
  { id: "type", label: "Type" },
  { id: "enabled", label: "Enabled" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
] as const;

function SecretsTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname.startsWith("/secrets/accounts") ? "accounts" : "keys";
  return (
    <div className="border-b border-border/60 px-6 pt-3">
      <Tabs value={current} onValueChange={(v) => navigate(v === "accounts" ? "/secrets/accounts" : "/secrets/keys")}>
        <TabsList>
          <TabsTrigger value="keys">Keys</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

export function AccountList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "accounts" });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const { data: accounts = [], isLoading, isRefetching } = useQuery({
    queryKey: ["accounts"],
    queryFn: api.listAccounts,
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Account deleted");
    },
  });

  const activeAccounts = useMemo(() => accounts.filter((a: AccountDocument) => !a.deletedAt), [accounts]);

  const typeOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of activeAccounts) {
      map.set(a.type, (map.get(a.type) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({
        value,
        label: ACCOUNT_TYPE_LABELS[value as keyof typeof ACCOUNT_TYPE_LABELS] ?? value,
        count,
      }));
  }, [activeAccounts]);

  const selectedTypes = state.getFilterList("type");

  const filteredAccounts = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    return activeAccounts.filter((a) => {
      if (selectedTypes.length > 0 && !selectedTypes.includes(a.type)) return false;
      if (q) {
        const blob = `${a._id} ${a.comment ?? ""} ${a.type}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeAccounts, selectedTypes, state.search]);

  const sortedAccounts = useMemo(() => {
    if (!state.sort) return filteredAccounts;
    const sorted = [...filteredAccounts];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredAccounts, state.sort, state.sortDir]);

  const total = sortedAccounts.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedAccounts.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<AccountDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "130px",
      hidden: columnVisibility.isHidden("id"),
      cell: (a) => (
        <span className="font-mono text-xs">{formatId(a._id)}</span>
      ),
    },
    {
      id: "comment",
      header: "Comment",
      hidden: columnVisibility.isHidden("comment"),
      cell: (a) => (
        <span className="text-sm max-w-[200px] truncate block" title={a.comment ?? undefined}>
          {a.comment || <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    {
      id: "type",
      header: "Type",
      sortable: true,
      width: "120px",
      hidden: columnVisibility.isHidden("type"),
      cell: (a) => (
        <Badge variant="outline" className="text-xs">
          {ACCOUNT_TYPE_LABELS[a.type]}
        </Badge>
      ),
    },
    {
      id: "enabled",
      header: "Enabled",
      width: "80px",
      hidden: columnVisibility.isHidden("enabled"),
      cell: (a) => (
        <Badge variant={a.enabled ? "default" : "secondary"} className="text-xs">
          {a.enabled ? "Yes" : "No"}
        </Badge>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "140px",
      hidden: columnVisibility.isHidden("created"),
      cell: (a) => (
        <span className="text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right",
      hidden: columnVisibility.isHidden("actions"),
      cell: (a) => (
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
              <AlertDialogTitle>Delete account?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes the account. The KeyVault secret is preserved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(a._id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SecretsTabs />
      <div className="min-h-0 flex-1">
        <ListLayout
          title="Accounts"
          description="Service credentials for key-updater automation"
          railStorageKey="accounts"
          actions={
            <Link to="/secrets/accounts/new">
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" /> Register Account
              </Button>
            </Link>
          }
          filterRail={
            <FilterRail
              search={state.search}
              onSearchChange={state.setSearch}
              searchPlaceholder="Search accounts…"
              refreshing={isRefetching}
              footer={
                <>
                  <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
                  <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
                </>
              }
            >
              <FilterSection title="Type" storageKey="accounts-type">
                <CheckboxFilterGroup
                  options={typeOptions}
                  selected={selectedTypes}
                  onToggle={(v) => state.toggleFilterValue("type", v)}
                />
              </FilterSection>
            </FilterRail>
          }
          secondaryPanel={
            customizeOpen ? (
              <CustomizeColumnsPanel
                columns={COLUMN_OPTIONS}
                hidden={columnVisibility.hidden}
                onToggle={columnVisibility.toggle}
                onSetHidden={columnVisibility.setHidden}
                onReset={columnVisibility.reset}
                onClose={() => setCustomizeOpen(false)}
              />
            ) : null
          }
          onSecondaryClose={() => setCustomizeOpen(false)}
        >
          <div className="flex flex-col gap-3">
            <DataTable
              items={pageItems}
              columns={columns}
              getRowId={(a) => a._id}
              onRowClick={(a) => navigate(`/secrets/accounts/${a._id}`)}
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={isLoading}
              emptyState={
                state.hasActiveFilters
                  ? "No accounts match your filters"
                  : "No accounts registered yet"
              }
            />
            <Pagination
              page={state.page}
              pageSize={state.pageSize}
              total={total}
              onPageChange={state.setPage}
              onPageSizeChange={state.setPageSize}
              itemLabel="accounts"
            />
          </div>
        </ListLayout>
      </div>
    </div>
  );
}

function sortKey(a: AccountDocument, col: string): string | number {
  switch (col) {
    case "id": return a._id;
    case "type": return a.type.toLowerCase();
    case "created": return new Date(a.createdAt).getTime();
    default: return "";
  }
}
