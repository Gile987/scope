// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileSystemCriteriaProvider } from './criteria-provider-fs.js';

let tmpDir: string | null = null;

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'fs-criteria-test-'));
  return tmpDir;
}

function writeYaml(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf-8');
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('FileSystemCriteriaProvider', () => {
  describe('construction', () => {
    it('handles a non-existent directory gracefully (empty registry)', async () => {
      const provider = new FileSystemCriteriaProvider('/no/such/path/12345');
      expect(await provider.size()).toBe(0);
    });

    it('loads a single .yaml file', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yaml', 'id: c1\nprompt: Check output\n');
      const provider = new FileSystemCriteriaProvider(dir);
      expect(await provider.size()).toBe(1);
      expect(await provider.has('c1')).toBe(true);
    });

    it('loads a .yml file (alternate extension)', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yml', 'id: c1\nprompt: A check\n');
      const provider = new FileSystemCriteriaProvider(dir);
      expect(await provider.has('c1')).toBe(true);
    });

    it('ignores non-YAML files', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'note.txt', 'not yaml');
      writeYaml(dir, 'c1.yaml', 'id: c1\nprompt: ok\n');
      const provider = new FileSystemCriteriaProvider(dir);
      expect(await provider.size()).toBe(1);
    });

    it('normalises snake_case depends_on to dependsOn', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yaml', 'id: c1\nprompt: root\n');
      writeYaml(dir, 'c2.yaml', 'id: c2\nprompt: child\ndepends_on:\n  - c1\n');
      const provider = new FileSystemCriteriaProvider(dir);
      const c2 = await provider.get('c2');
      expect(c2?.dependsOn).toEqual(['c1']);
    });

    it('normalises camelCase dependsOn', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yaml', 'id: c1\nprompt: root\n');
      writeYaml(dir, 'c2.yaml', 'id: c2\nprompt: child\ndependsOn:\n  - c1\n');
      const provider = new FileSystemCriteriaProvider(dir);
      const c2 = await provider.get('c2');
      expect(c2?.dependsOn).toEqual(['c1']);
    });

    it('trims whitespace from id and prompt', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yaml', "id: '  c1  '\nprompt: '  Hello  '\n");
      const provider = new FileSystemCriteriaProvider(dir);
      const c = await provider.get('c1');
      expect(c?.id).toBe('c1');
      expect(c?.prompt).toBe('Hello');
    });

    it('throws on duplicate criteria ids', () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'a.yaml', 'id: dup\nprompt: first\n');
      writeYaml(dir, 'b.yaml', 'id: dup\nprompt: second\n');
      expect(() => new FileSystemCriteriaProvider(dir)).toThrow(/[Dd]uplicate/);
    });

    it('throws when id field is missing', () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'bad.yaml', 'prompt: no id here\n');
      expect(() => new FileSystemCriteriaProvider(dir)).toThrow(/id/);
    });

    it('throws when prompt field is missing', () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'bad.yaml', 'id: c1\n');
      expect(() => new FileSystemCriteriaProvider(dir)).toThrow(/prompt/);
    });
  });

  describe('get / has / size', () => {
    it('get returns undefined for unknown ids', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'c1.yaml', 'id: c1\nprompt: ok\n');
      const provider = new FileSystemCriteriaProvider(dir);
      expect(await provider.get('ghost')).toBeUndefined();
    });

    it('has returns false for unknown ids', async () => {
      const provider = new FileSystemCriteriaProvider(makeTmpDir());
      expect(await provider.has('nope')).toBe(false);
    });

    it('size reflects number of loaded files', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'a.yaml', 'id: a\nprompt: a\n');
      writeYaml(dir, 'b.yaml', 'id: b\nprompt: b\n');
      expect(await new FileSystemCriteriaProvider(dir).size()).toBe(2);
    });
  });

  describe('getAll', () => {
    it('returns all loaded criteria', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'a.yaml', 'id: a\nprompt: A\n');
      writeYaml(dir, 'b.yaml', 'id: b\nprompt: B\n');
      const all = await new FileSystemCriteriaProvider(dir).getAll();
      expect(all.map(c => c.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('resolveWithAncestors', () => {
    it('returns the requested criteria when no dependencies', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'a.yaml', 'id: a\nprompt: A\n');
      writeYaml(dir, 'b.yaml', 'id: b\nprompt: B\n');
      const result = await new FileSystemCriteriaProvider(dir).resolveWithAncestors(['a']);
      expect(result.map(c => c.id)).toEqual(['a']);
    });

    it('includes transitive parents', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'root.yaml', 'id: root\nprompt: Root\n');
      writeYaml(dir, 'mid.yaml', 'id: mid\nprompt: Mid\ndepends_on:\n  - root\n');
      writeYaml(dir, 'leaf.yaml', 'id: leaf\nprompt: Leaf\ndepends_on:\n  - mid\n');
      const result = await new FileSystemCriteriaProvider(dir).resolveWithAncestors(['leaf']);
      const ids = result.map(c => c.id).sort();
      expect(ids).toEqual(['leaf', 'mid', 'root']);
    });

    it('deduplicates in a diamond dependency', async () => {
      const dir = makeTmpDir();
      writeYaml(dir, 'a.yaml', 'id: a\nprompt: A\n');
      writeYaml(dir, 'b.yaml', 'id: b\nprompt: B\ndepends_on:\n  - a\n');
      writeYaml(dir, 'c.yaml', 'id: c\nprompt: C\ndepends_on:\n  - a\n');
      writeYaml(dir, 'd.yaml', 'id: d\nprompt: D\ndepends_on:\n  - b\n  - c\n');
      const result = await new FileSystemCriteriaProvider(dir).resolveWithAncestors(['d']);
      expect(result.map(c => c.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('throws when a requested id does not exist', async () => {
      const dir = makeTmpDir();
      const provider = new FileSystemCriteriaProvider(dir);
      await expect(provider.resolveWithAncestors(['missing'])).rejects.toThrow(/missing/);
    });
  });
});
