// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileSystemCriteriaProvider } from './criteria-provider-fs.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'fs-criteria-test-'));
  return tempDir;
}

function writeYaml(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

describe('FileSystemCriteriaProvider', () => {
  it('loads no criteria from an empty directory', async () => {
    const dir = makeDir();
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.getAll()).toHaveLength(0);
  });

  it('does not throw for non-existent directory', () => {
    expect(() => new FileSystemCriteriaProvider('/nonexistent/path/xyz')).not.toThrow();
  });

  it('loads a single .yaml file', async () => {
    const dir = makeDir();
    writeYaml(dir, 'check.yaml', 'id: c1\nprompt: "Check output"\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const all = await provider.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('c1');
    expect(all[0].prompt).toBe('Check output');
    expect(all[0].dependsOn).toEqual([]);
  });

  it('loads a single .yml file', async () => {
    const dir = makeDir();
    writeYaml(dir, 'check.yml', 'id: c1\nprompt: "Check"\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(1);
  });

  it('ignores non-YAML files', async () => {
    const dir = makeDir();
    writeYaml(dir, 'readme.md', 'id: c1\nprompt: "ignored"');
    writeYaml(dir, 'check.yaml', 'id: c1\nprompt: "real"\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.size()).toBe(1);
  });

  it('normalizes snake_case depends_on to dependsOn', async () => {
    const dir = makeDir();
    writeYaml(dir, 'p.yaml', 'id: parent\nprompt: "Parent"\n');
    writeYaml(dir, 'c.yaml', 'id: child\nprompt: "Child"\ndepends_on:\n  - parent\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const child = await provider.get('child');
    expect(child?.dependsOn).toEqual(['parent']);
  });

  it('accepts camelCase dependsOn', async () => {
    const dir = makeDir();
    writeYaml(dir, 'p.yaml', 'id: parent\nprompt: "Parent"\n');
    writeYaml(dir, 'c.yaml', 'id: child\nprompt: "Child"\ndependsOn:\n  - parent\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const child = await provider.get('child');
    expect(child?.dependsOn).toEqual(['parent']);
  });

  it('throws on duplicate criteria id', () => {
    const dir = makeDir();
    writeYaml(dir, 'a.yaml', 'id: dup\nprompt: "First"\n');
    writeYaml(dir, 'b.yaml', 'id: dup\nprompt: "Second"\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow("Duplicate criteria id 'dup'");
  });

  it('throws on missing id field', () => {
    const dir = makeDir();
    writeYaml(dir, 'bad.yaml', 'prompt: "No id"\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow("Missing or invalid 'id' field");
  });

  it('throws on missing prompt field', () => {
    const dir = makeDir();
    writeYaml(dir, 'bad.yaml', 'id: c1\n');
    expect(() => new FileSystemCriteriaProvider(dir)).toThrow("Missing or invalid 'prompt' field");
  });

  it('get returns undefined for unknown id', async () => {
    const dir = makeDir();
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.get('unknown')).toBeUndefined();
  });

  it('has returns true for existing id', async () => {
    const dir = makeDir();
    writeYaml(dir, 'c.yaml', 'id: c1\nprompt: "Check"\n');
    const provider = new FileSystemCriteriaProvider(dir);
    expect(await provider.has('c1')).toBe(true);
    expect(await provider.has('nope')).toBe(false);
  });

  it('resolveWithAncestors returns single item with no deps', async () => {
    const dir = makeDir();
    writeYaml(dir, 'c.yaml', 'id: c1\nprompt: "Check"\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['c1']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });

  it('resolveWithAncestors pulls in transitive parents', async () => {
    const dir = makeDir();
    writeYaml(dir, 'a.yaml', 'id: a\nprompt: "A"\n');
    writeYaml(dir, 'b.yaml', 'id: b\nprompt: "B"\ndepends_on:\n  - a\n');
    writeYaml(dir, 'c.yaml', 'id: c\nprompt: "C"\ndepends_on:\n  - b\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['c']);
    const ids = result.map(r => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(ids).toHaveLength(3);
  });

  it('resolveWithAncestors deduplicates in diamond structure', async () => {
    const dir = makeDir();
    writeYaml(dir, 'root.yaml', 'id: root\nprompt: "Root"\n');
    writeYaml(dir, 'left.yaml', 'id: left\nprompt: "Left"\ndepends_on:\n  - root\n');
    writeYaml(dir, 'right.yaml', 'id: right\nprompt: "Right"\ndepends_on:\n  - root\n');
    writeYaml(dir, 'bottom.yaml', 'id: bottom\nprompt: "Bottom"\ndepends_on:\n  - left\n  - right\n');
    const provider = new FileSystemCriteriaProvider(dir);
    const result = await provider.resolveWithAncestors(['bottom']);
    const ids = result.map(r => r.id);
    expect(ids).toHaveLength(4);
    expect(ids.filter(id => id === 'root')).toHaveLength(1);
  });

  it('resolveWithAncestors throws for unknown id', async () => {
    const dir = makeDir();
    const provider = new FileSystemCriteriaProvider(dir);
    await expect(provider.resolveWithAncestors(['unknown'])).rejects.toThrow(
      "Criteria 'unknown' not found"
    );
  });
});
