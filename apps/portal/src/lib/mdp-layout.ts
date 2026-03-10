// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Minimal types needed for layout (avoids @/ alias so tests can import directly)

interface MdpCriterionStateForLayout {
  id: string;
  passed: boolean;
}

interface MdpFeatureStateForLayout {
  id: string;
  detected: boolean;
}

// ─── Layout constants ────────────────────────────────────────────────────────

export const NODE_MIN_WIDTH = 180;
export const NODE_HEIGHT_BASE = 48; // base + per-criterion row height
export const NODE_ROW_HEIGHT = 20;

// Width estimation: ~6.5px per char at text-[10px] monospace, plus padding for
// dot (6px) + gap (6px) + inner px-1.5*2 (12px) + outer px-3*2 (24px) + border ≈ 50px
export const CHAR_WIDTH_PX = 6.5;
export const LABEL_PADDING_PX = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MdpNodeData {
  criteria: MdpCriterionStateForLayout[];
  features?: MdpFeatureStateForLayout[];
  nodeType?: string;
  visits: number;
  isInitial?: boolean;
  isTerminal?: boolean;
  passedCount: number;
  totalCount: number;
  /** Estimated width in px — set by layout, used to constrain the DOM node */
  layoutWidth?: number;
  [key: string]: unknown;
}

export interface NodeSize {
  width: number;
  height: number;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function getNodeHeight(criteriaCount: number, featureCount?: number): number {
  const rowCount = Math.max(criteriaCount, featureCount || 0);
  return NODE_HEIGHT_BASE + rowCount * NODE_ROW_HEIGHT;
}

/**
 * Estimate the rendered width of a node based on its longest label.
 * Labels are rendered in ~10px monospace font, so we approximate
 * character width and add horizontal padding for the dot, gaps, and
 * container padding.  The result is clamped to at least NODE_MIN_WIDTH.
 */
export function estimateNodeWidth(data: MdpNodeData): number {
  const labels: string[] = [];

  if (data.nodeType === "prompt-features" && data.features) {
    for (const f of data.features) labels.push(f.id);
    // header text
    labels.push(data.features.length === 0 ? "No features extracted" : "Task Features");
  } else {
    for (const c of data.criteria) labels.push(c.id);
  }

  if (labels.length === 0) return NODE_MIN_WIDTH;

  const longestLen = Math.max(...labels.map((l) => l.length));
  return Math.max(NODE_MIN_WIDTH, Math.ceil(longestLen * CHAR_WIDTH_PX + LABEL_PADDING_PX));
}
