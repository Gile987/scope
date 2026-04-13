// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function validateTrigger(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== "object") {
    return "trigger must be an object";
  }
  const t = trigger as Record<string, unknown>;
  if (!t.type || typeof t.type !== "string") {
    return "trigger.type is required and must be a string";
  }
  switch (t.type) {
    case "always":
      return null;
    case "criteria":
      if (!Array.isArray(t.criteriaIds) || t.criteriaIds.length === 0) {
        return "trigger.criteriaIds must be a non-empty array of strings";
      }
      if (!t.criteriaIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.criteriaIds must only contain strings";
      }
      if (t.match !== undefined && t.match !== "any" && t.match !== "all") {
        return "trigger.match must be 'any' or 'all'";
      }
      return null;
    case "taskPrompt":
      if (!Array.isArray(t.taskPromptIds) || t.taskPromptIds.length === 0) {
        return "trigger.taskPromptIds must be a non-empty array of strings";
      }
      if (!t.taskPromptIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.taskPromptIds must only contain strings";
      }
      return null;
    case "promptFeature":
      if (!Array.isArray(t.featureIds) || t.featureIds.length === 0) {
        return "trigger.featureIds must be a non-empty array of strings";
      }
      if (!t.featureIds.every((id: unknown) => typeof id === "string")) {
        return "trigger.featureIds must only contain strings";
      }
      if (t.match !== undefined && t.match !== "any" && t.match !== "all") {
        return "trigger.match must be 'any' or 'all'";
      }
      return null;
    default:
      return `Unknown trigger type: '${t.type}'. Valid types: always, criteria, taskPrompt, promptFeature`;
  }
}
