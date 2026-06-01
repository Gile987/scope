// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Textarea } from "./textarea";
import { Label } from "./label";

const meta = {
  component: Textarea,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Describe the task the agent should implement..." },
  play: async ({ canvas }) => {
    const textarea = canvas.getByPlaceholderText(/describe the task/i);
    await expect(textarea.tagName.toLowerCase()).toBe("textarea");
  },
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-md gap-1.5">
      <Label htmlFor="task">Task prompt</Label>
      <Textarea id="task" rows={4} defaultValue="Build a hello-world Express server." />
    </div>
  ),
};

export const Disabled: Story = {
  args: { placeholder: "Disabled", disabled: true },
};
