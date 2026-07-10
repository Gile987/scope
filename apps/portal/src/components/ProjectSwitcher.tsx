// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, ChevronsUpDown, FolderKanban, Plus, Settings2 } from "lucide-react";

import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";

/** Stable id accessor — the API mirrors `_id` onto `id`, but fall back defensively. */
function projectId(project: Project): string {
  return project.id ?? project._id;
}

/**
 * Presentational dropdown for the project switcher — pure props, no data
 * fetching, context, or mutations, so it is trivially story/play-testable.
 * The {@link ProjectSwitcher} container wires it to react-query + context.
 */
export function ProjectSwitcherView({
  projects,
  activeProjectId,
  isLoading = false,
  onSelect,
  onNewProject,
  className,
}: {
  projects: Project[];
  activeProjectId?: string;
  isLoading?: boolean;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  className?: string;
}) {
  const active = projects.find((p) => projectId(p) === activeProjectId);
  const label = active?.name ?? (activeProjectId ? activeProjectId : "Select project");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 max-w-[12rem] gap-1.5 px-2",
            !activeProjectId && "text-action",
            className,
          )}
          aria-label="Switch project"
        >
          <FolderKanban className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isLoading ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : projects.length === 0 ? (
          <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
        ) : (
          projects.map((project) => {
            const id = projectId(project);
            const selected = id === activeProjectId;
            return (
              <DropdownMenuItem
                key={id}
                onClick={() => {
                  if (!selected) onSelect(id);
                }}
                className="gap-2"
              >
                <span className="flex-1 truncate">{project.name}</span>
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNewProject} className="gap-2">
          <Plus className="h-4 w-4" />
          <span>New project…</span>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="gap-2">
          <Link to="/projects">
            <Settings2 className="h-4 w-4" />
            <span>Manage projects</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Header control for viewing and switching the active project (mirrors the
 * placement of {@link ThemeToggle}). Loads the project list, shows the active
 * one, lets the user switch (which invalidates scoped queries via
 * {@link useSelectProject}) or create a new project inline, and links to the
 * `/projects` management page.
 */
export function ProjectSwitcher({ className }: { className?: string }) {
  const { selectedProjectId } = useProjectContext();
  const selectProject = useSelectProject();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    // Wrap rather than pass `api.listProjects` directly: its optional
    // `{ includeDeleted? }` arg is a weak type, so react-query's
    // QueryFunctionContext isn't assignable to it (TS "no common properties").
    queryFn: () => api.listProjects(),
  });

  return (
    <>
      <ProjectSwitcherView
        projects={projects}
        activeProjectId={selectedProjectId ?? undefined}
        isLoading={isLoading}
        onSelect={selectProject}
        onNewProject={() => setCreateOpen(true)}
        className={className}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Create a project to organize runs, profiles, criteria, and more.
            </DialogDescription>
          </DialogHeader>
          <ProjectCreateForm
            onCancel={() => setCreateOpen(false)}
            onCreated={(project) => {
              setCreateOpen(false);
              // Select the new project and refresh scoped data + the list.
              selectProject(projectId(project));
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
