// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileSystemCriteriaProvider } from './criteria-provider-fs.js';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fs-criteria-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs = [];
});

function writeCriteria(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

describe('FileSystemCriteriaProvider construction', () => {
  it('loads zero criteria from an empty directory', async () => {
    const dir = makeTempDir();
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(0);
    expect(await provider.getAll()).toEqual([]);
  });

  it('loads criteria from a valid YAML file', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'c1.yaml', 'id: c1\nprompt: Does it compile?\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(1);
    expect(await provider.get('c1')).toMatchObject({ id: 'c1', prompt: 'Does it compile?' });
  });

  it('loads criteria from multiple YAML files', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'a.yaml', 'id: a\nprompt: Prompt A\n');
    writeCriteria(dir, 'b.yml', 'id: b\nprompt: Prompt B\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(2);
  });

  it('ignores non-YAML files', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'notes.txt'), 'not a criteria file');
    writeCriteria(dir, 'c1.yaml', 'id: c1\nprompt: p1\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(1);
  });

  it('handles a non-existent directory gracefully (empty)', async () => {
    const provider = new FileSystemCriteriaProvider('/does/not/exist');
    expect(await provider.size()).toBe(0);
  });

  it('normalises snake_case depends_on', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'parent.yaml', 'id: parent\nprompt: Parent\n');
    writeCriteria(dir, 'child.yaml', 'id: child\nprompt: Child\ndepends_on:\n  - parent\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const child = await provider.get('child');
    expect(child?.dependsOn).toEqual(['parent']);
  });

  it('normalises camelCase dependsOn', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'parent.yaml', 'id: parent\nprompt: Parent\n');
    writeCriteria(dir, 'child.yaml', 'id: child\nprompt: Child\ndependsOn:\n  - parent\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const child = await provider.get('child');
    expect(child?.dependsOn).toEqual(['parent']);
  });

  it('throws on duplicate criteria ids across files', () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'a.yaml', 'id: dup\nprompt: First\n');
    writeCriteria(dir, 'b.yaml', 'id: dup\nprompt: Second\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow("Duplicate criteria id 'dup'");
  });

  it('throws on missing id field', () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'bad.yaml', 'prompt: No id here\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow();
  });

  it('throws on missing prompt field', () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'bad.yaml', 'id: c1\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow();
  });
});

describe('FileSystemCriteriaProvider.get / has', () => {
  it('returns undefined for unknown id', async () => {
    const dir = makeTempDir();
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.get('unknown')).toBeUndefined();
  });

  it('returns false for unknown id', async () => {
    const dir = makeTempDir();
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.has('unknown')).toBe(false);
  });

  it('returns true for known id', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'c1.yaml', 'id: c1\nprompt: p\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.has('c1')).toBe(true);
  });

  it('trims whitespace from id and prompt', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'c1.yaml', 'id: "  c1  "\nprompt: "  padded  "\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const c = await provider.get('c1');
    expect(c?.id).toBe('c1');
    expect(c?.prompt).toBe('padded');
  });
});

describe('FileSystemCriteriaProvider.resolveWithAncestors', () => {
  it('resolves a single root criterion', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'a.yaml', 'id: a\nprompt: pa\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['a']);
    expect(result.map(c => c.id)).toContain('a');
  });

  it('includes transitive ancestors', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'a.yaml', 'id: a\nprompt: pa\n');
    writeCriteria(dir, 'b.yaml', 'id: b\nprompt: pb\ndepends_on:\n  - a\n');
    writeCriteria(dir, 'c.yaml', 'id: c\nprompt: pc\ndepends_on:\n  - b\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['c']);
    const ids = result.map(c => c.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates shared ancestors (diamond)', async () => {
    const dir = makeTempDir();
    writeCriteria(dir, 'root.yaml', 'id: root\nprompt: p\n');
    writeCriteria(dir, 'b.yaml', 'id: b\nprompt: p\ndepends_on:\n  - root\n');
    writeCriteria(dir, 'c.yaml', 'id: c\nprompt: p\ndepends_on:\n  - root\n');
    writeCriteria(dir, 'd.yaml', 'id: d\nprompt: p\ndepends_on:\n  - b\n  - c\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['d']);
    const ids = result.map(c => c.id).sort();
    expect(ids).toEqual(['b', 'c', 'd', 'root']);
  });

  it('throws when resolving an unknown criterion id', async () => {
    const dir = makeTempDir();
    const provider = new FileSystemCriteriaProvider(dir);
    await expect(provider.resolveWithAncestors(['missing'])).rejects.toThrow(
      "Criteria 'missing' not found"
    );
  });
});
