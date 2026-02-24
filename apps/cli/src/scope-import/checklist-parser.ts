// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Parse SCOPE criterion `instructions` text into individual checklist items.
 *
 * SCOPE criteria follow a consistent format:
 *   - {title}
 *     - skipped: {condition}
 *     - passes: {condition}
 *     - fails: {condition}
 *
 * Each checklist item becomes one boolean SCOPE-MT criterion.
 */

/** A single parsed checklist item from a SCOPE criterion's instructions. */
export interface ChecklistItem {
  /** The checklist item title (e.g., "Uses Azure AI Foundry or GitHub Models for LLM") */
  title: string;
  /** When the check is skipped (e.g., "never", "No secrets required") */
  skipped: string;
  /** Conditions for passing */
  passes: string;
  /** Conditions for failing */
  fails: string;
}

/**
 * Strip `<criteria>...</criteria>` XML wrapper and markdown headers from
 * SCOPE instructions, leaving only the checklist content.
 */
function stripWrapper(instructions: string): string {
  let text = instructions;

  // Remove <criteria> tags
  text = text.replace(/<\/?criteria>/g, '');

  // Remove the standard preamble lines:
  //   "Evaluate the solution based on the following criterion:"
  //   "## Title"
  //   "**Weight: ...**"
  //   "### Instruction"
  //   "**IMPORTANT**: For each check, ..."
  //   "Check that the application ... Use the following checklist to evaluate:"
  // We strip everything up to and including the last line before the first "- " checklist item.
  const firstItemMatch = text.match(/\n(- [^\n])/);
  if (firstItemMatch && firstItemMatch.index !== undefined) {
    text = text.slice(firstItemMatch.index);
  }

  return text.trim();
}

/**
 * Parse a single checklist item block into a ChecklistItem.
 *
 * Input format (already split from the main text):
 * ```
 * - Uses Azure AI Foundry (Azure OpenAI) or GitHub Models for LLM
 *   - skipped: never
 *   - passes: Any of the following are present:
 *     - Code/SDK: `@azure/openai`, ...
 *     - Endpoints: `*.openai.azure.com`, ...
 *   - fails: Only non-Azure LLM providers ...
 * ```
 */
function parseItemBlock(block: string): ChecklistItem | null {
  const lines = block.split('\n');

  // First line is the title (after "- ")
  const titleMatch = lines[0]?.match(/^-\s+(.+)/);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();

  // Parse sub-fields: skipped, passes, fails
  // These are at indentation level 2+ (e.g., "  - skipped: ...")
  // Each can span multiple lines if the next lines are further indented
  let skipped = '';
  let passes = '';
  let fails = '';

  let currentField: 'skipped' | 'passes' | 'fails' | null = null;
  let currentContent: string[] = [];

  const flushField = () => {
    if (currentField && currentContent.length > 0) {
      const content = currentContent.join('\n').trim();
      if (currentField === 'skipped') skipped = content;
      else if (currentField === 'passes') passes = content;
      else if (currentField === 'fails') fails = content;
    }
    currentContent = [];
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Check for a new sub-field (indented "- skipped:", "- passes:", "- fails:")
    const fieldMatch = line.match(/^\s+-\s+(skipped|passes|fails):\s*(.*)/i);
    if (fieldMatch) {
      flushField();
      currentField = fieldMatch[1].toLowerCase() as 'skipped' | 'passes' | 'fails';
      if (fieldMatch[2].trim()) {
        currentContent.push(fieldMatch[2].trim());
      }
      continue;
    }

    // Continuation line — only if we're inside a field
    if (currentField) {
      currentContent.push(line.trimEnd());
    }
  }
  flushField();

  if (!title) return null;

  return { title, skipped, passes, fails };
}

/**
 * Parse a SCOPE criterion's `instructions` field into individual checklist items.
 *
 * Returns an array of ChecklistItem. If the instructions don't contain a
 * recognizable checklist format, returns an empty array (the caller should
 * fall back to emitting the entire instructions as a single criterion).
 */
export function parseChecklist(instructions: string): ChecklistItem[] {
  const stripped = stripWrapper(instructions);

  // Split into blocks at each top-level "- " (checklist item boundary).
  // A top-level item starts at column 0 with "- ".
  // Sub-items are indented (2+ spaces before "- ").
  const blocks: string[] = [];
  let currentBlock: string[] = [];

  for (const line of stripped.split('\n')) {
    // New top-level item
    if (/^- \S/.test(line)) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
      }
      currentBlock = [line];
    } else {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  // Parse each block
  const items: ChecklistItem[] = [];
  for (const block of blocks) {
    const item = parseItemBlock(block);
    if (item && (item.passes || item.fails)) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Check whether a SCOPE criterion's instructions contain a parseable checklist.
 * Some criteria (e.g., "latest dependencies") use a procedural format instead.
 */
export function hasChecklistFormat(instructions: string): boolean {
  return parseChecklist(instructions).length > 0;
}
