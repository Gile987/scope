// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CheckCircle2, XCircle, MinusCircle, type LucideIcon } from "lucide-react";

/** Visual state for a single evaluated criterion (true=passed, false=failed, undefined=not evaluated/skipped). */
export type CriterionResultState = boolean | undefined;

export interface CriterionResultStyle {
  colorClass: string;
  Icon: LucideIcon;
  label: string;
  title: string;
}

/**
 * Returns the color class, icon, label and tooltip title for a criterion
 * result state so the same visual treatment is applied consistently across
 * RunsList and RunDetail.
 */
export function criterionResultStyle(result: CriterionResultState): CriterionResultStyle {
  if (result === true) {
    return {
      colorClass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      Icon: CheckCircle2,
      label: "true",
      title: "Passed",
    };
  }
  if (result === false) {
    return {
      colorClass: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
      Icon: XCircle,
      label: "false",
      title: "Failed",
    };
  }
  return {
    colorClass: "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
    Icon: MinusCircle,
    label: "–",
    title: "Not evaluated",
  };
}
