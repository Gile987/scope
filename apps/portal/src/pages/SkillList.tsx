// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SkillDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, BookOpen, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { SkillPicker } from "@/components/SkillPicker";

export function SkillList() {
  const queryClient = useQueryClient();

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

  const activeSkills = skills.filter((s: SkillDocument) => !s.deletedAt);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Skills</h1>
        <p className="text-muted-foreground">Manage agent skills injected into coding agent prompts</p>
      </div>

      {/* Import skill card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Import Skill
          </CardTitle>
          <CardDescription>
            Search the external skills registry or add a skill manually by entering its GitHub repo and skill name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SkillPicker selected={[]} onChange={() => {}} importOnly />
        </CardContent>
      </Card>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeSkills.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No skills imported yet. Click <strong>Import Skill</strong> to add one from a GitHub repository.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeSkills.map((skill: SkillDocument) => (
                <TableRow key={skill.id}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/skills/${skill.id}`} className="flex items-center gap-1.5 hover:underline">
                      <BookOpen className="h-3.5 w-3.5" />
                      {skill.id}
                    </Link>
                  </TableCell>
                  <TableCell>{skill.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {skill.source}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {skill.origin}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(skill.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete skill?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This soft-deletes the skill &quot;{skill.name}&quot;. It will no longer be available for new runs.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMutation.mutate(skill.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
