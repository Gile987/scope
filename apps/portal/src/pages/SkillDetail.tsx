// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SkillRevisionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, RefreshCw, Loader2, BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function SkillDetail() {
  const { "*": slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expandedRevision, setExpandedRevision] = useState<string | null>(null);

  const { data: skill, isLoading, error } = useQuery({
    queryKey: ["skill", slug],
    queryFn: () => api.getSkill(slug!),
    enabled: !!slug,
  });

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["skill-revisions", slug],
    queryFn: () => api.listSkillRevisions(slug!),
    enabled: !!slug,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSkill(slug!),
    onSuccess: () => {
      toast.success("Skill deleted");
      navigate("/skills");
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () => api.resolveSkill(slug!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skill-revisions", slug] });
      toast.success("Skill resolved — new revision created");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to resolve skill");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/skills")}>
          <ArrowLeft className="h-4 w-4" /> Back to Skills
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Skill not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/skills")}>
        <ArrowLeft className="h-4 w-4" /> Back to Skills
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight">{skill.name}</h1>
            <Badge variant="outline" className="text-xs">{skill.origin}</Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono mt-1">{skill._id}</p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="gap-1.5">
              <Trash2 className="h-4 w-4" /> Delete
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
              <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Details card */}
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-[10rem_1fr] gap-y-3 text-sm">
            <span className="text-muted-foreground">Name</span>
            <span>{skill.name}</span>

            <span className="text-muted-foreground">Source</span>
            <span className="font-mono text-xs">{skill.source}</span>

            <span className="text-muted-foreground">Skill Name</span>
            <span className="font-mono text-xs">{skill.skillName}</span>

            <span className="text-muted-foreground">Origin</span>
            <Badge variant="outline" className="w-fit text-xs">{skill.origin}</Badge>

            {skill.description && (
              <>
                <span className="text-muted-foreground">Description</span>
                <span>{skill.description}</span>
              </>
            )}

            <span className="text-muted-foreground">Created</span>
            <span className="text-xs text-muted-foreground">{formatDate(skill.createdAt)}</span>

            {skill.updatedAt && (
              <>
                <span className="text-muted-foreground">Updated</span>
                <span className="text-xs text-muted-foreground">{formatDate(skill.updatedAt)}</span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Resolve action */}
      <Card>
        <CardHeader>
          <CardTitle>Resolve</CardTitle>
          <CardDescription>
            Fetch the latest version of this skill from GitHub and create a new revision snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => resolveMutation.mutate()}
            disabled={resolveMutation.isPending}
            className="gap-1.5"
          >
            {resolveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Resolve from GitHub
          </Button>
        </CardContent>
      </Card>

      {/* Revisions */}
      <Card>
        <CardHeader>
          <CardTitle>Revisions</CardTitle>
          <CardDescription>
            Immutable snapshots of this skill resolved from GitHub at specific commits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingRevisions ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : revisions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No revisions yet. Click &quot;Resolve from GitHub&quot; to create the first one.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commit</TableHead>
                    <TableHead>Resolved</TableHead>
                    <TableHead className="text-right">Content</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {revisions.map((rev: SkillRevisionDocument) => (
                    <>
                      <TableRow key={rev._id}>
                        <TableCell className="font-mono text-xs">
                          {rev.commitHash.slice(0, 7)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(rev.resolvedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() =>
                              setExpandedRevision(
                                expandedRevision === rev._id ? null : rev._id,
                              )
                            }
                          >
                            {expandedRevision === rev._id ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )}
                            {expandedRevision === rev._id ? "Hide" : "Show"}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expandedRevision === rev._id && (
                        <TableRow key={`${rev._id}-content`}>
                          <TableCell colSpan={3} className="p-0">
                            <div className="prose prose-sm dark:prose-invert max-w-none p-4 max-h-96 overflow-y-auto">
                              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{rev.content}</ReactMarkdown>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
