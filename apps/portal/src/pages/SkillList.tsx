// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { SkillDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, BookOpen, Download } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { SkillPicker } from "@/components/SkillPicker";
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

const FILTER_KEYS = ["origin"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "id", label: "Slug", required: true },
  { id: "name", label: "Name" },
  { id: "source", label: "Source" },
  { id: "origin", label: "Origin" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function SkillList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "skills" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteSkill,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill deleted");
    },
  });

  const activeSkills = useMemo(
    () => skills.filter((s: SkillDocument) => !s.deletedAt),
    [skills],
  );

  const originOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of activeSkills) map.set(s.origin, (map.get(s.origin) ?? 0) + 1);
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
  }, [activeSkills]);

  const filteredSkills = useMemo(() => {
    const origins = state.getFilterList("origin");
    const q = state.search.trim().toLowerCase();
    return activeSkills.filter((s) => {
      if (origins.length > 0 && !origins.includes(s.origin)) return false;
      if (q) {
        const blob = `${s._id} ${s.name} ${s.source}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeSkills, state]);

  const sortedSkills = useMemo(() => {
    if (!state.sort) return filteredSkills;
    const sorted = [...filteredSkills];
    sorted.sort((a, b) => {
      const av = skillSortKey(a, state.sort!);
      const bv = skillSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredSkills, state.sort, state.sortDir]);

  const total = sortedSkills.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedSkills.slice(pageStart, pageStart + state.pageSize);

  const columns: DataTableColumn<SkillDocument>[] = [
    {
      id: "id",
      header: "Slug",
      sortable: true,
      width: "200px",
      cell: (s) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
          {s._id}
        </span>
      ),
    },
    ...(!columnVisibility.isHidden("name") ? [{
      id: "name",
      header: "Name",
      sortable: true,
      cell: (s: SkillDocument) => <span className="text-sm">{s.name}</span>,
    }] : []),
    ...(!columnVisibility.isHidden("source") ? [{
      id: "source",
      header: "Source",
      cell: (s: SkillDocument) => (
        <span className="font-mono text-xs text-muted-foreground">{s.source}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("origin") ? [{
      id: "origin",
      header: "Origin",
      width: "120px",
      cell: (s: SkillDocument) => (
        <Badge variant="outline" className="text-xs">{s.origin}</Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("created") ? [{
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (s: SkillDocument) => (
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
              onClick={(ev) => ev.stopPropagation()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(ev) => ev.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete skill?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes the skill &quot;{s.name}&quot;. It will no longer be available for new runs.
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
    <>
      <ListLayout
        title="Skills"
        description="Manage agent skills injected into coding agent prompts"
        railStorageKey="skills"
        actions={
          <Button className="gap-1.5" onClick={() => setImportOpen(true)}>
            <Download className="h-4 w-4" /> Import Skill
          </Button>
        }
        filterRail={
          <FilterRail
            search={state.search}
            onSearchChange={state.setSearch}
            searchPlaceholder="Search skills…"
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
            <FilterSection title="Origin" storageKey="skills-origin">
              <CheckboxFilterGroup
                options={originOptions}
                selected={state.getFilterList("origin")}
                onToggle={(v) => state.toggleFilterValue("origin", v)}
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
      >
        <div className="flex flex-col gap-3">
          <DataTable
            items={pageItems}
            columns={columns}
            getRowId={(s) => s._id}
            onRowClick={(s) => navigate(`/skills/${s._id}`)}
            sort={state.sort}
            sortDir={state.sortDir}
            onSortChange={state.toggleSort}
            loading={isLoading}
            emptyState={
              state.hasActiveFilters
                ? "No skills match your filters"
                : "No skills imported yet. Click Import Skill to add one from a GitHub repository."
            }
          />
          <Pagination
            page={state.page}
            pageSize={state.pageSize}
            total={total}
            onPageChange={state.setPage}
            onPageSizeChange={state.setPageSize}
            itemLabel="skills"
          />
        </div>
      </ListLayout>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Skill</DialogTitle>
          </DialogHeader>
          <SkillPicker selected={[]} onChange={() => {}} importOnly />
        </DialogContent>
      </Dialog>
    </>
  );
}

function skillSortKey(s: SkillDocument, col: string): string | number {
  switch (col) {
    case "id": return s._id;
    case "name": return s.name.toLowerCase();
    case "created": return new Date(s.createdAt).getTime();
    default: return "";
  }
}
