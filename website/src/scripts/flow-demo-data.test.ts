// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { sampleAgents, sampleProfiles } from './sample-agents';
import { criterionOutcomes, demoCriteria, formatDelta, formatDuration, gateOutcomes, scenarios, totalTokens } from './flow-demo-data';

describe('playground fixtures', () => {
	it('only runs supported agents and identifies a single base profile', () => {
		expect(sampleProfiles.filter((profile) => profile.id === 'base')).toHaveLength(1);
		expect(sampleProfiles.every((profile) => profile.agent.status === 'Supported today')).toBe(true);
		expect(sampleAgents.filter((agent) => agent.status === 'Planned').map((agent) => agent.name)).toEqual(['OpenAI Codex', 'OpenCode']);
		expect(sampleProfiles[1].agent).toBe(sampleProfiles[0].agent);
	});

	it.each(Object.values(scenarios))('provides complete, positive metrics for $id', (scenario) => {
		for (const profile of sampleProfiles) {
			const result = scenario.results[profile.id];
			expect(totalTokens(result)).toBe(result.inputTokens + result.outputTokens);
			expect(result.inputTokens).toBeGreaterThan(0);
			expect(result.outputTokens).toBeGreaterThan(0);
			expect(result.durationSeconds).toBeGreaterThan(0);
			expect(criterionOutcomes(result).size).toBe(demoCriteria.length);
		}
	});

	it('skips later gates after a failed build', () => {
		const result = scenarios.board.results.agent;
		expect(gateOutcomes(result)).toEqual(['Pass', 'Fail', 'Skipped']);
		expect([...criterionOutcomes(result).values()]).toEqual(['Pass', 'Fail', 'Skipped', 'Skipped', 'Skipped']);
	});

	it('skips both dependent checks when their parent fails', () => {
		const result = scenarios.api.results.skills;
		expect(gateOutcomes(result)).toEqual(['Pass', 'Pass', 'Fail']);
		expect([...criterionOutcomes(result).values()]).toEqual(['Pass', 'Pass', 'Fail', 'Skipped', 'Skipped']);
	});

	it('does not skip a sibling criterion when the edge-case check fails', () => {
		expect([...criterionOutcomes(scenarios.board.results.base).values()]).toEqual(['Pass', 'Pass', 'Pass', 'Pass', 'Fail']);
	});

	it('reports all gates passed only when every criterion passes', () => {
		expect(gateOutcomes(scenarios.board.results.skills)).toEqual(['Pass', 'Pass', 'Pass']);
		expect(gateOutcomes(scenarios.api.results.agent)).toEqual(['Pass', 'Pass', 'Pass']);
	});

	it('formats exact, signed deltas against the base', () => {
		expect(formatDelta(18000, 21600, 'tokens')).toBe('-3,600 tokens vs base');
		expect(formatDelta(23400, 13500, 'tokens')).toBe('+9,900 tokens vs base');
		expect(formatDelta(128, 154, 'sec')).toBe('-26 sec vs base');
		expect(formatDelta(154, 154, 'sec')).toBe('Same as base');
		expect(formatDuration(154)).toBe('2m 34s');
		expect(formatDuration(60)).toBe('1m 00s');
	});
});
