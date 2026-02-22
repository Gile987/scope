// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import {
  formatAsTable,
  formatAsTSV,
  formatAsJSON,
  formatData,
  isMachineReadable,
  getValueOrNA,
  formatDate,
  maxColumnWidth,
} from './formatters.js';
import type { DisplayField, TableColumn } from './types.js';

// ── Helper data ──────────────────────────────────────────────────────────────

const sampleItems = [
  { id: 'abc-123', name: 'First', status: 'completed' },
  { id: 'def-456', name: 'Second', status: 'failed' },
  { id: 'ghi-789', name: 'Third', status: 'pending' },
];

const displayFields: DisplayField[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
];

// ── getValueOrNA ─────────────────────────────────────────────────────────────

describe('getValueOrNA', () => {
  it('returns string value for non-null input', () => {
    expect(getValueOrNA('hello')).toBe('hello');
    expect(getValueOrNA(42)).toBe('42');
    expect(getValueOrNA(true)).toBe('true');
  });

  it('returns N/A for null, undefined, and empty string', () => {
    expect(getValueOrNA(null)).toBe('N/A');
    expect(getValueOrNA(undefined)).toBe('N/A');
    expect(getValueOrNA('')).toBe('N/A');
  });
});

// ── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats a valid ISO date string', () => {
    const result = formatDate('2025-01-15T10:30:00Z');
    expect(result).not.toBe('N/A');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns N/A for undefined', () => {
    expect(formatDate(undefined)).toBe('N/A');
  });

  it('returns N/A for empty string', () => {
    expect(formatDate('')).toBe('N/A');
  });
});

// ── maxColumnWidth ───────────────────────────────────────────────────────────

describe('maxColumnWidth', () => {
  it('calculates width from data', () => {
    const data = [{ name: 'abc' }, { name: 'abcdef' }];
    // 'abcdef' = 6 chars + 2 padding = 8
    expect(maxColumnWidth(data, 'name')).toBe(8);
  });

  it('respects minWidth', () => {
    const data = [{ name: 'ab' }];
    // minWidth 10 + padding 2 = 12
    expect(maxColumnWidth(data, 'name', 10)).toBe(12);
  });

  it('handles empty arrays', () => {
    expect(maxColumnWidth([], 'name')).toBe(12); // default 10 + 2 padding
  });
});

// ── formatAsTable ────────────────────────────────────────────────────────────

describe('formatAsTable', () => {
  it('produces bordered table output', () => {
    const columns: TableColumn[] = [
      { key: 'id', header: 'ID' },
      { key: 'name', header: 'Name' },
      { key: 'status', header: 'Status' },
    ];

    const result = formatAsTable(sampleItems, columns);

    // Check headers present
    expect(result).toContain('ID');
    expect(result).toContain('Name');
    expect(result).toContain('Status');

    // Check data present
    expect(result).toContain('abc-123');
    expect(result).toContain('Second');
    expect(result).toContain('pending');

    // Check table borders (cli-table3 uses ─, │, etc.)
    expect(result).toContain('─');
  });

  it('uses custom formatters', () => {
    const columns: TableColumn[] = [
      { key: 'id', header: 'ID', formatter: (item) => `[${item.id}]` },
      { key: 'status', header: 'Status' },
    ];

    const result = formatAsTable(sampleItems, columns);
    expect(result).toContain('[abc-123]');
  });

  it('handles empty array', () => {
    const columns: TableColumn[] = [
      { key: 'id', header: 'ID' },
    ];

    const result = formatAsTable([], columns);
    // Should produce table with headers but no data rows
    expect(result).toContain('ID');
  });

  it('handles missing properties with N/A', () => {
    const items = [{ id: 'test' }]; // no 'name' property
    const columns: TableColumn[] = [
      { key: 'id', header: 'ID' },
      { key: 'name', header: 'Name' },
    ];

    const result = formatAsTable(items, columns);
    expect(result).toContain('N/A');
  });
});

// ── formatAsTSV ──────────────────────────────────────────────────────────────

describe('formatAsTSV', () => {
  it('produces tab-separated output without headers', () => {
    const result = formatAsTSV(sampleItems, displayFields);

    const lines = result.split('\n');
    expect(lines).toHaveLength(3);

    // Check tab separation
    const firstLine = lines[0].split('\t');
    expect(firstLine).toHaveLength(3);
    expect(firstLine[0]).toBe('abc-123');
    expect(firstLine[1]).toBe('First');
    expect(firstLine[2]).toBe('completed');
  });

  it('uses custom formatters', () => {
    const fields: DisplayField[] = [
      { key: 'id', label: 'ID', formatter: (item) => item.id.toUpperCase() },
    ];

    const result = formatAsTSV(sampleItems, fields);
    expect(result).toContain('ABC-123');
  });

  it('handles empty array', () => {
    const result = formatAsTSV([], displayFields);
    expect(result).toBe('');
  });

  it('handles null/undefined values', () => {
    const items = [{ id: 'test', name: null, status: undefined }];
    const result = formatAsTSV(items as any, displayFields);
    expect(result).toContain('N/A');
  });

  it('no trailing newline for clean piping', () => {
    const result = formatAsTSV(sampleItems, displayFields);
    expect(result.endsWith('\n')).toBe(false);
  });
});

// ── formatAsJSON ─────────────────────────────────────────────────────────────

describe('formatAsJSON', () => {
  it('produces valid JSON array', () => {
    const result = formatAsJSON(sampleItems, displayFields);
    const parsed = JSON.parse(result);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ id: 'abc-123', name: 'First', status: 'completed' });
  });

  it('applies custom formatters to JSON values', () => {
    const fields: DisplayField[] = [
      { key: 'id', label: 'ID', formatter: (item) => `prefix:${item.id}` },
    ];

    const result = formatAsJSON(sampleItems, fields);
    const parsed = JSON.parse(result);
    expect(parsed[0].id).toBe('prefix:abc-123');
  });

  it('handles empty array', () => {
    const result = formatAsJSON([], displayFields);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([]);
  });

  it('is pretty-printed with 2-space indent', () => {
    const result = formatAsJSON(sampleItems, displayFields);
    // Pretty-printed JSON starts with [\n  {
    expect(result).toMatch(/^\[\n {2}\{/);
  });
});

// ── formatData (dispatcher) ──────────────────────────────────────────────────

describe('formatData', () => {
  it('dispatches to table format', () => {
    const result = formatData(sampleItems, displayFields, 'table');
    // Table format has borders
    expect(result).toContain('─');
    expect(result).toContain('abc-123');
  });

  it('dispatches to tsv format', () => {
    const result = formatData(sampleItems, displayFields, 'tsv');
    // TSV: no borders, tab-separated
    expect(result).not.toContain('─');
    expect(result).toContain('\t');
    expect(result).toContain('abc-123');
  });

  it('dispatches to json format', () => {
    const result = formatData(sampleItems, displayFields, 'json');
    const parsed = JSON.parse(result);
    expect(parsed[0].id).toBe('abc-123');
  });

  it('throws on unsupported format', () => {
    expect(() => formatData(sampleItems, displayFields, 'yaml' as any)).toThrow(
      'Unsupported output format: yaml',
    );
  });
});

// ── isMachineReadable ────────────────────────────────────────────────────────

describe('isMachineReadable', () => {
  it('returns true for tsv and json', () => {
    expect(isMachineReadable('tsv')).toBe(true);
    expect(isMachineReadable('json')).toBe(true);
  });

  it('returns false for table', () => {
    expect(isMachineReadable('table')).toBe(false);
  });
});
