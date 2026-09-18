// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SampleProfile } from './sample-agents';

export const demoGates = [
	{ id: 'select', label: 'Requirements' },
	{ id: 'build', label: 'Build' },
	{ id: 'test', label: 'Test' },
] as const;

export const demoCriteria = [
	{ id: 'implements_task', gate: 'select', label: 'Task implemented', dependsOn: [] },
	{ id: 'builds', gate: 'build', label: 'Build succeeds', dependsOn: [] },
	{ id: 'tests_run', gate: 'test', label: 'Tests execute', dependsOn: [] },
	{ id: 'tests_pass', gate: 'test', label: 'Tests pass', dependsOn: ['tests_run'] },
	{ id: 'edge_case', gate: 'test', label: 'Handles empty input', dependsOn: ['tests_run'] },
] as const;

type CriterionId = typeof demoCriteria[number]['id'];
export type DemoOutcome = 'Pass' | 'Fail' | 'Skipped';

interface DemoResult {
	failedCriterion: CriterionId | null;
	inputTokens: number;
	outputTokens: number;
	durationSeconds: number;
}

export interface DemoScenario {
	id: string;
	title: string;
	short: string;
	prompt: string;
	edge: string;
	context: string;
	results: Record<SampleProfile, DemoResult>;
}

// Invented fixtures teach how to read a comparison, not which setup performs best.
export const scenarios: Record<string, DemoScenario> = {
	board: {
		id: 'task-board',
		title: 'Build a task board',
		short: 'A small app. Real acceptance criteria.',
		prompt: 'Build a task board. Users can add tasks, mark them complete, and filter by status. An empty title must not create a task.',
		edge: 'Handles empty input',
		context: 'Create a task board with add, complete, and filter actions. Define the expected behavior before the agents start.',
		results: {
			base: { failedCriterion: 'edge_case', inputTokens: 18400, outputTokens: 3200, durationSeconds: 154 },
			skills: { failedCriterion: null, inputTokens: 15100, outputTokens: 2900, durationSeconds: 128 },
			agent: { failedCriterion: 'builds', inputTokens: 9900, outputTokens: 1900, durationSeconds: 82 },
		},
	},
	api: {
		id: 'search-api',
		title: 'Add a search API',
		short: 'One endpoint. The details matter.',
		prompt: 'Add a paginated search endpoint. Return matching items, validate the page size, and return an empty list when nothing matches.',
		edge: 'Handles no matches',
		context: 'Add search with pagination and input validation. Give every sample profile the same task and the same acceptance criteria.',
		results: {
			base: { failedCriterion: 'builds', inputTokens: 11200, outputTokens: 2300, durationSeconds: 96 },
			skills: { failedCriterion: 'tests_run', inputTokens: 19800, outputTokens: 3600, durationSeconds: 173 },
			agent: { failedCriterion: null, inputTokens: 17600, outputTokens: 3100, durationSeconds: 149 },
		},
	},
};

export function criterionOutcomes(result: DemoResult): Map<CriterionId, DemoOutcome> {
	const outcomes = new Map<CriterionId, DemoOutcome>();
	let priorGateFailed = false;
	for (const gate of demoGates) {
		let gateFailed = false;
		for (const criterion of demoCriteria.filter((item) => item.gate === gate.id)) {
			const skipped = priorGateFailed || criterion.dependsOn.some((id) => outcomes.get(id) !== 'Pass');
			const outcome = skipped ? 'Skipped' : criterion.id === result.failedCriterion ? 'Fail' : 'Pass';
			outcomes.set(criterion.id, outcome);
			if (outcome === 'Fail') gateFailed = true;
		}
		priorGateFailed ||= gateFailed;
	}
	return outcomes;
}

export function gateOutcomes(result: DemoResult): DemoOutcome[] {
	const outcomes = criterionOutcomes(result);
	return demoGates.map((gate) => {
		const values = demoCriteria.filter((criterion) => criterion.gate === gate.id).map((criterion) => outcomes.get(criterion.id));
		return values.includes('Fail') ? 'Fail' : values.every((value) => value === 'Pass') ? 'Pass' : 'Skipped';
	});
}

export function totalTokens(result: DemoResult): number {
	return result.inputTokens + result.outputTokens;
}

export function formatDuration(seconds: number): string {
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatDelta(value: number, base: number, unit: string): string {
	const delta = value - base;
	return delta === 0 ? 'Same as base' : `${delta > 0 ? '+' : ''}${delta.toLocaleString('en-US')} ${unit} vs base`;
}
