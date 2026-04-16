// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Map a raw YAML document to a criterion API payload.
 * Supports both snake_case (YAML convention) and camelCase field names.
 */
export function mapYamlCriterion(
  doc: Record<string, unknown>,
  filename: string,
  _docIndex: number
): { id: string; prompt: string; dependsOn?: string[] } | null {
  const id = doc.id as string | undefined;
  const prompt = doc.prompt as string | undefined;
  if (!id || !prompt) return null;

  // Support both snake_case (YAML convention) and camelCase
  const depsRaw = (doc.depends_on ?? doc.dependsOn) as string[] | undefined;
  const dependsOn = Array.isArray(depsRaw) ? depsRaw.map(d => String(d).trim()) : undefined;

  return {
    id: id.trim(),
    prompt: prompt.trim(),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

/**
 * Map a raw YAML document to a report-template API payload.
 * Supports both snake_case (YAML convention) and camelCase field names.
 */
export function mapYamlReportTemplate(
  doc: Record<string, unknown>,
  _filename: string,
  _docIndex: number
): Record<string, unknown> | null {
  const id = doc.id as string | undefined;
  const name = doc.name as string | undefined;
  const userPrompt = (doc.user_prompt ?? doc.userPrompt) as string | undefined;
  if (!id || !name || !userPrompt) return null;

  const result: Record<string, unknown> = {
    id: id.trim(),
    name: name.trim(),
    userPrompt: userPrompt.trim(),
  };

  const description = doc.description as string | undefined;
  if (description) result.description = description.trim();

  const model = doc.model as string | undefined;
  if (model) result.model = model.trim();

  const timeoutMs = (doc.timeout_ms ?? doc.timeoutMs) as number | undefined;
  if (timeoutMs) result.timeoutMs = Number(timeoutMs);

  // System prompt: support snake_case YAML
  const sysCfg = (doc.system_prompt ?? doc.systemPrompt) as Record<string, unknown> | undefined;
  if (sysCfg && sysCfg.mode && sysCfg.content) {
    result.systemPrompt = {
      mode: String(sysCfg.mode).trim(),
      content: String(sysCfg.content).trim(),
    };
  }

  // Trigger
  const triggerCfg = doc.trigger as Record<string, unknown> | undefined;
  if (triggerCfg && triggerCfg.type) {
    const trigger: Record<string, unknown> = { type: String(triggerCfg.type).trim() };
    const triggerType = trigger.type as string;

    if (triggerType === 'criteria') {
      const ids = (triggerCfg.criteria_ids ?? triggerCfg.criteriaIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.criteriaIds = ids.map(s => String(s).trim());
      if (triggerCfg.match) trigger.match = String(triggerCfg.match).trim();
    } else if (triggerType === 'taskPrompt') {
      const ids = (triggerCfg.task_prompt_ids ?? triggerCfg.taskPromptIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.taskPromptIds = ids.map(s => String(s).trim());
    } else if (triggerType === 'promptFeature') {
      const ids = (triggerCfg.feature_ids ?? triggerCfg.featureIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.featureIds = ids.map(s => String(s).trim());
      if (triggerCfg.match) trigger.match = String(triggerCfg.match).trim();
    }

    result.trigger = trigger;
  }

  return result;
}
