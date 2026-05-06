// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { criterionResultStyle, type CriterionResultState } from "@/lib/criteria-result";

interface CriteriaBadgeProps {
  criterionId: string;
  result?: CriterionResultState;
  evaluated?: boolean;
  link?: boolean;
  showStateLabel?: boolean;
  className?: string;
}

export function CriteriaBadge({
  criterionId,
  result,
  evaluated = false,
  link = true,
  showStateLabel = false,
  className,
}: CriteriaBadgeProps) {
  const content = !evaluated ? (
    <Badge variant="secondary" className={cn("font-mono text-xs", className)}>
      {criterionId}
    </Badge>
  ) : (() => {
    const { colorClass, Icon, label, title } = criterionResultStyle(result);
    return (
      <Badge
        variant="outline"
        className={cn("font-mono text-xs", colorClass, className)}
        title={title}
      >
        <Icon className="h-3 w-3 shrink-0 mr-1" />
        {showStateLabel ? `${criterionId}: ${label}` : criterionId}
      </Badge>
    );
  })();

  if (!link) return content;

  return (
    <Link to={`/criteria/${criterionId}`} className="inline-flex" title={criterionId}>
      {content}
    </Link>
  );
}
