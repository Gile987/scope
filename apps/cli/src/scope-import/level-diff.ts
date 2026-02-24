// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ScopeLevel } from './types.js';

/**
 * Result of diffing two consecutive SCOPE levels.
 */
export interface LevelDelta {
  fromLevel: string;
  toLevel: string;
  /** The text that was added in the higher level. */
  addedText: string;
  /** Whether this is a cumulative addition (prefix match) or a full rewrite. */
  isCumulative: boolean;
}

/**
 * Normalize whitespace in an instruction string for reliable comparison.
 * Collapses multiple whitespace chars to a single space, trims.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the text delta between two consecutive levels.
 *
 * SCOPE levels are cumulative for propensity (L0→L3): each level prepends
 * the previous level's text and appends new guidance. For efficacy levels
 * (L4, L5), the base task may be similar but the requirements section is
 * rewritten.
 *
 * Strategy:
 * 1. Normalize whitespace for comparison.
 * 2. If the higher level starts with the lower level's text (prefix match),
 *    extract the suffix as the delta → cumulative.
 * 3. Otherwise, mark as a full rewrite and return the entire higher level text.
 */
export function extractDelta(
  lowerLevel: ScopeLevel,
  higherLevel: ScopeLevel
): LevelDelta {
  const lowerNorm = normalizeWhitespace(lowerLevel.instruction);
  const higherNorm = normalizeWhitespace(higherLevel.instruction);

  if (higherNorm.startsWith(lowerNorm)) {
    // Cumulative: extract the suffix
    const addedNorm = higherNorm.slice(lowerNorm.length).trim();
    // Now find the actual (non-normalized) added text in the original
    const addedText = findOriginalSuffix(
      lowerLevel.instruction,
      higherLevel.instruction
    );

    return {
      fromLevel: lowerLevel.metadata.level,
      toLevel: higherLevel.metadata.level,
      addedText: addedText || addedNorm,
      isCumulative: true,
    };
  }

  // Full rewrite — return the entire instruction
  return {
    fromLevel: lowerLevel.metadata.level,
    toLevel: higherLevel.metadata.level,
    addedText: higherLevel.instruction.trim(),
    isCumulative: false,
  };
}

/**
 * Find the original (non-normalized) suffix of the higher level instruction
 * that extends beyond the lower level instruction.
 *
 * Works by finding the longest prefix of the higher text (character by character,
 * ignoring whitespace differences) that matches the lower text.
 */
export function findOriginalSuffix(
  lower: string,
  higher: string
): string {
  const lowerChars = lower.replace(/\s+/g, ' ').trim();
  const higherFull = higher;
  const higherNorm = higher.replace(/\s+/g, ' ').trim();

  if (!higherNorm.startsWith(lowerChars)) {
    return higher.trim();
  }

  // Walk through the original higher text, counting non-whitespace-normalized
  // characters to find where the lower text ends
  let normIdx = 0;
  let origIdx = 0;
  const targetNormLen = lowerChars.length;

  while (normIdx < targetNormLen && origIdx < higherFull.length) {
    // Skip extra whitespace in original (normalized treats as single space)
    if (/\s/.test(higherFull[origIdx])) {
      // Consume all whitespace in original
      while (origIdx < higherFull.length && /\s/.test(higherFull[origIdx])) {
        origIdx++;
      }
      // Advance past the single space in normalized
      if (normIdx < targetNormLen && lowerChars[normIdx] === ' ') {
        normIdx++;
      }
    } else {
      normIdx++;
      origIdx++;
    }
  }

  return higherFull.slice(origIdx).trim();
}

/**
 * Extract all deltas from a sequence of SCOPE levels.
 * Groups by type (Propensity: L0→L1→L2→L3, Efficacy: L4→L5).
 */
export function extractAllDeltas(levels: ScopeLevel[]): LevelDelta[] {
  const deltas: LevelDelta[] = [];

  // Sort levels by level tag
  const sorted = [...levels].sort((a, b) =>
    a.metadata.level.localeCompare(b.metadata.level)
  );

  // Group by type
  const propensity = sorted.filter((l) => l.metadata.type === 'Propensity');
  const efficacy = sorted.filter((l) => l.metadata.type === 'Efficacy');

  // Extract propensity deltas (L0→L1, L1→L2, L2→L3)
  for (let i = 1; i < propensity.length; i++) {
    deltas.push(extractDelta(propensity[i - 1], propensity[i]));
  }

  // Extract efficacy deltas (L4→L5)
  for (let i = 1; i < efficacy.length; i++) {
    deltas.push(extractDelta(efficacy[i - 1], efficacy[i]));
  }

  return deltas;
}
