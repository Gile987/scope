// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { criterionResultStyle, type CriterionResultState } from "@/lib/criteria-result";
import type { CriterionKind } from "@/types";

interface CriteriaBadgeProps {
  criterionId: string;
  result?: CriterionResultState;
  evaluated?: boolean;
  link?: boolean;
  showStateLabel?: boolean;
  className?: string;
  kind?: CriterionKind;
}

export function CriteriaBadge({
  criterionId,
  result,
  evaluated = false,
  link = true,
  showStateLabel = false,
  className,
  kind,
}: CriteriaBadgeProps) {
  const kindLabel = kind === "observation" ? "Obs" : kind === "gate" ? "Gate" : undefined;
  const content = !evaluated ? (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary" className={cn("font-mono text-xs", className)}>
        {criterionId}
      </Badge>
      {kindLabel && <CriteriaKindBadge kind={kind} />}
    </span>
  ) : (() => {
    const { colorClass, Icon, label, title } = criterionResultStyle(result);
    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          variant="outline"
          className={cn("font-mono text-xs", colorClass, className)}
          title={title}
        >
          <Icon className="h-3 w-3 shrink-0 mr-1" />
          {showStateLabel ? `${criterionId}: ${label}` : criterionId}
        </Badge>
        {kindLabel && <CriteriaKindBadge kind={kind} />}
      </span>
    );
  })();

  if (!link) return content;

  return (
    <Link to={`/criteria/${criterionId}`} className="inline-flex" title={criterionId}>
      {content}
    </Link>
  );
}

export function CriteriaKindBadge({ kind, className }: { kind?: CriterionKind; className?: string }) {
  const normalized = kind ?? "gate";
  return (
    <Badge
      variant={normalized === "observation" ? "outline" : "secondary"}
      className={cn(
        "text-[10px] uppercase tracking-wide",
        normalized === "observation" && "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        className,
      )}
    >
      {normalized === "observation" ? "Observation" : "Gate"}
    </Badge>
  );
}
