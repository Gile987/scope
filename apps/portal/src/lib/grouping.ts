// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AggregateStats } from "../types";
||||||| a003cac6
import type { AggregateStats } from "../types";

export function formatStatRange(
  stat: AggregateStats | null,
  formatter: (v: number) => string = (v) => v.toLocaleString(),
): string {
  if (!stat) return "–";
  if (stat.min === stat.max) return formatter(stat.min);
  return `${formatter(stat.min)}–${formatter(stat.max)} (μ${formatter(Math.round(stat.mean * 10) / 10)}${stat.stdDev > 0 ? ` σ${formatter(Math.round(stat.stdDev * 10) / 10)}` : ""})`;
}
