// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

interface SkillPreviewPanelProps {
  slug: string;
}

export function SkillPreviewPanel({ slug }: SkillPreviewPanelProps) {
  const navigate = useNavigate();

  const { data: skill, isLoading, error } = useQuery({
    queryKey: ["skill", slug],
    queryFn: () => api.getSkill(slug),
    enabled: !!slug,
  });

  const closePanel = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("preview");
    const search = params.toString();
    navigate({ pathname: "/skills", search: search ? `?${search}` : "" });
  };

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !skill) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Skill not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5 truncate">
          <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{skill.name}</span>
        </span>
      }
      subtitle={<span className="font-mono">{skill._id}</span>}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/skills/${skill._id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> Open full view
            </Button>
          </Link>
        </div>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Skill name</dt>
                <dd className="mt-0.5 font-mono text-xs">{skill.skillName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Source</dt>
                <dd className="mt-0.5 break-all font-mono text-xs">{skill.source}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Origin</dt>
                <dd className="mt-0.5">
                  <Badge variant="outline" className="text-xs">{skill.origin}</Badge>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {skill.description && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {skill.description}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(skill.createdAt)}</dd>
              </div>
              {skill.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(skill.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
