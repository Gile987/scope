// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { stripYamlPreamble } from './parser.js';

describe('parser', () => {
  describe('stripYamlPreamble', () => {
    it('strips shell echo preamble lines', () => {
      const input = [
        '',
        '> @scope/scope@ scope /some/path',
        '> pnpm exec tsx ./packages/cli/index.ts scenario show -i abc -o yaml',
        '',
        '_id: abc123',
        'name: Test Scenario',
      ].join('\n');

      const result = stripYamlPreamble(input);
      expect(result).toBe('_id: abc123\nname: Test Scenario');
    });

    it('returns content unchanged when no preamble', () => {
      const input = '_id: abc123\nname: Test Scenario';
      expect(stripYamlPreamble(input)).toBe(input);
    });

    it('handles empty string', () => {
      expect(stripYamlPreamble('')).toBe('');
    });

    it('handles content starting with ---', () => {
      const input = '---\n_id: abc123\nname: Test';
      expect(stripYamlPreamble(input)).toBe(input);
    });
  });
});
