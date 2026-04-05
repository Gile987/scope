// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Action handler for `run get` subcommand — extracted for testability.
 */
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon } from "./utils/style.js";
import { formatData, isMachineReadable } from "./utils/formatters.js";
import type { OutputFormat, DisplayField } from "./utils/types.js";

/** Strip trailing slashes from a URL */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

export interface RunGetOptions {
  id: string;
  url: string;
  output: string;
}

export async function runGetAction(options: RunGetOptions): Promise<void> {
  const format = (options.output || 'table') as OutputFormat;
  try {
  const response = await fetch(`${normalizeUrl(options.url)}/api/v1/requests/${options.id}`);

  if (!response.ok) {
    const error = await response.json();
    console.error(errorText("Error:"), error.error || JSON.stringify(error));
    process.exit(1);
  }

  const run = await response.json();

  // Machine-readable output
  if (isMachineReadable(format)) {
    const fields: DisplayField[] = [
      { key: 'id', label: 'ID' },
      { key: 'workerType', label: 'Worker' },
      { key: 'model', label: 'Model' },
      { key: 'status', label: 'Status' },
      { key: 'maxIterations', label: 'Max Iterations' },
      { key: 'turnsCount', label: 'Turns' },
      { key: 'passed', label: 'Passed' },
      { key: 'task', label: 'Task' },
      { key: 'criteriaCount', label: 'Criteria' },
      { key: 'logsCount', label: 'Logs' },
      { key: 'createdAt', label: 'Created' },
      { key: 'updatedAt', label: 'Updated' },
      { key: 'error', label: 'Error' },
    ];
    const row = {
      ...run,
      turnsCount: run.turns?.length ?? 0,
      passed: run.outcome === 'succeeded' ? 'yes' : run.outcome === 'failed' || run.outcome === 'exhausted' ? 'no' : '-',
      task: run.scenario?.task ?? '',
      criteriaCount: run.scenario?.criteria?.length ?? 0,
      logsCount: run.logs?.length ?? 0,
    };
    console.log(formatData([row], fields, format));
    return;
  }

  // Human-readable output
  console.log(`${label('ID:')}             ${value(run.id)}`);
  console.log(`${label('Worker:')}         ${value(run.workerType)}`);
  if (run.model) console.log(`${label('Model:')}          ${value(run.model)}`);

  const statusColor = run.outcome === 'succeeded' ? successText
    : (run.outcome === 'failed' || run.outcome === 'exhausted') ? errorText
    : value;
  console.log(`${label('Status:')}         ${statusColor(run.status)}`);
  if (run.outcome) console.log(`${label('Outcome:')}        ${statusColor(run.outcome)}`);

  if (run.maxIterations != null) console.log(`${label('Max Iterations:')} ${value(String(run.maxIterations))}`);
  if (run.createdAt) console.log(`${label('Created:')}        ${dimTimestamp(new Date(run.createdAt).toLocaleString())}`);
  if (run.updatedAt) console.log(`${label('Updated:')}        ${dimTimestamp(new Date(run.updatedAt).toLocaleString())}`);
  if (run.completedAt) console.log(`${label('Completed:')}      ${dimTimestamp(new Date(run.completedAt).toLocaleString())}`);

  // Persona
  if (run.persona) {
    const p = run.persona;
    console.log(`${label('Persona:')}        ${value(`${p.personality} / ${p.experience} / ${p.verbosity} / ${p.type}`)}`);
  }

  // Scenario
  if (run.scenario) {
    console.log(`${label('Task:')}`);
    for (const line of (run.scenario.task ?? '').trim().split('\n')) {
      console.log(`  ${line}`);
    }
    if (run.scenario.criteria?.length > 0) {
      console.log(`${label('Criteria:')}       ${value(String(run.scenario.criteria.length))} criterion/criteria`);
      // Build a lookup from the last turn's criteria results
      const lastTurn = run.turns?.length ? run.turns[run.turns.length - 1] : null;
      const resultsMap = new Map<string, { passed: boolean; evaluated: boolean }>();
      if (lastTurn?.criteriaResults) {
        for (const cr of lastTurn.criteriaResults) {
          resultsMap.set(cr.criterionId, { passed: cr.passed, evaluated: cr.evaluated });
        }
      }
      for (const c of run.scenario.criteria) {
        const r = resultsMap.get(c);
        const icon = r ? criterionIcon(r.evaluated, r.passed) : '  ';
        console.log(`  ${icon} ${c}`);
      }
    }
  }

  // Turns summary
  if (run.turns?.length > 0) {
    console.log(`\n${banner('─── Turns ───')}`);
    for (const turn of run.turns) {
      const passIcon = criterionIcon(true, turn.passed);
      const criteriaStr = turn.criteriaResults?.length
        ? ` — ${turn.criteriaResults.filter((cr: { passed: boolean }) => cr.passed).length}/${turn.criteriaResults.length} criteria passed`
        : '';
      console.log(`  ${label(`Turn ${turn.iteration}:`)} ${passIcon}${criteriaStr}`);
    }
  }

  // Error
  if (run.error) {
    console.log(`${label('Error:')}          ${errorText(run.error)}`);
  }

  // Logs count
  if (run.logs?.length != null) {
    console.log(`${label('Logs:')}           ${value(String(run.logs.length))} entries`);
  }

  // Prompt feature extraction
  if (run.promptFeatureExtractionId) {
    console.log(`${label('Prompt Features:')} ${value(run.promptFeatureExtractionId)}`);
  }

  // Soft-deleted
  if (run.deletedAt) {
    console.log(`${label('Deleted:')}        ${warnBanner(new Date(run.deletedAt).toLocaleString())}`);
  }
  } catch (error) {
    console.error(errorText("Error:"), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
