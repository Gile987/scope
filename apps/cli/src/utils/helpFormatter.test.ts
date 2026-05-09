// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { generateEnvVarsHelp } from './helpFormatter.js';

// Strip ANSI escape codes so assertions are insensitive to terminal styling.
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

describe('generateEnvVarsHelp', () => {
  it('renders a section header, each var, and the .env hint', () => {
    const out = stripAnsi(
      generateEnvVarsHelp({
        FOO_URL: { description: 'Base URL for foo', default: 'http://localhost:1234' },
        BAR_DIR: { description: 'Directory for bar' },
      }),
    );

    expect(out).toContain('Environment Variables:');
    expect(out).toContain('FOO_URL');
    expect(out).toContain('Base URL for foo');
    expect(out).toContain('(default: http://localhost:1234)');
    expect(out).toContain('BAR_DIR');
    expect(out).toContain('Directory for bar');
    // Vars without a default must not render a "(default: ...)" annotation.
    expect(out).not.toMatch(/BAR_DIR.*\(default:/);
    expect(out).toContain('.env file in the current directory');
  });

  it('aligns variable names to the widest entry', () => {
    const out = stripAnsi(
      generateEnvVarsHelp({
        SHORT: { description: 'a' },
        A_VERY_LONG_VARIABLE_NAME: { description: 'b' },
      }),
    );

    const shortLine = out.split('\n').find((l) => l.includes('SHORT'))!;
    // 'SHORT' (5) padded to width of 'A_VERY_LONG_VARIABLE_NAME' (25) → 20 trailing spaces before the two-space gap.
    expect(shortLine).toMatch(/SHORT {20} {2}a/);
  });
});
