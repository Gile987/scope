// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkdownRenderer } from "./MarkdownRenderer";

const meta = {
  component: MarkdownRenderer,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BasicMarkdown: Story = {
  args: {
    children: "# Hello World\n\nThis is a **bold** paragraph with `inline code`.\n\n- Item 1\n- Item 2\n- Item 3",
  },
};

export const WithGfmTable: Story = {
  args: {
    children: "| Agent | Score |\n|-------|-------|\n| Copilot | 92% |\n| Claude | 88% |",
  },
};

export const WithGithubAlerts: Story = {
  args: {
    children: "> [!NOTE]\n> This is a note alert.\n\n> [!WARNING]\n> This is a warning alert.",
    githubAlerts: true,
  },
};

export const CodeBlock: Story = {
  args: {
    children: "```typescript\nconst result = await agent.run(task);\nconsole.log(result.score);\n```",
  },
};
