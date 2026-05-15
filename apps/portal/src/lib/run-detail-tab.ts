// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

type RunTabState = {
  status?: string;
  turns?: unknown[];
};

export function getRunDetailActiveTab(tab: string | undefined, activeRun: RunTabState | undefined): string {
  if (tab) return tab;

  const hasTurns = (activeRun?.turns?.length ?? 0) > 0;
  const isCompleted = activeRun?.status === "done";

  return hasTurns && isCompleted ? "turns" : "logs";
}
