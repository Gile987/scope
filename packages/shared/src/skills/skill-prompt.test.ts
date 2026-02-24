// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { formatSkillsPrompt, prependSkillsToMessage } from './skill-prompt.js';
import type { SkillConfig } from '../types/skill.js';

describe('formatSkillsPrompt', () => {
  it('returns empty string for no skills', () => {
    expect(formatSkillsPrompt([])).toBe('');
  });

  it('formats a single skill', () => {
    const skills: SkillConfig[] = [
      { name: 'my-skill', description: 'A test skill', content: 'Do the thing.\n\nWith details.' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toBe(
      '<skills>\n<skill name="my-skill">\nDo the thing.\n\nWith details.\n</skill>\n</skills>'
    );
  });

  it('formats multiple skills', () => {
    const skills: SkillConfig[] = [
      { name: 'skill-a', description: 'First', content: 'Content A' },
      { name: 'skill-b', description: 'Second', content: 'Content B' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('<skill name="skill-a">');
    expect(result).toContain('<skill name="skill-b">');
    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result.startsWith('<skills>')).toBe(true);
    expect(result.endsWith('</skills>')).toBe(true);
  });

  it('escapes XML special characters in skill name', () => {
    const skills: SkillConfig[] = [
      { name: 'skill<"test">', description: 'test', content: 'Body' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('name="skill&lt;&quot;test&quot;&gt;"');
  });

  it('trims content whitespace', () => {
    const skills: SkillConfig[] = [
      { name: 'trimmed', description: 'test', content: '  \n  Content here  \n  ' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('Content here');
    // Should not have leading/trailing whitespace within skill tags
    expect(result).toMatch(/<skill name="trimmed">\nContent here\n<\/skill>/);
  });
});

describe('prependSkillsToMessage', () => {
  it('returns message unchanged when no skills', () => {
    expect(prependSkillsToMessage('Hello world')).toBe('Hello world');
    expect(prependSkillsToMessage('Hello world', [])).toBe('Hello world');
    expect(prependSkillsToMessage('Hello world', undefined)).toBe('Hello world');
  });

  it('prepends skill context to message', () => {
    const skills: SkillConfig[] = [
      { name: 'react-best-practices', description: 'React', content: 'Use hooks.' },
    ];
    const result = prependSkillsToMessage('Build a todo app', skills);
    expect(result).toMatch(/^<skills>/);
    expect(result).toContain('Use hooks.');
    expect(result).toContain('Build a todo app');
    // Skills should come before the message
    const skillsEnd = result.indexOf('</skills>');
    const messageStart = result.indexOf('Build a todo app');
    expect(skillsEnd).toBeLessThan(messageStart);
  });

  it('separates skills preamble from message with double newline', () => {
    const skills: SkillConfig[] = [
      { name: 'test', description: 'test', content: 'Content' },
    ];
    const result = prependSkillsToMessage('Task', skills);
    expect(result).toContain('</skills>\n\nTask');
  });
});
