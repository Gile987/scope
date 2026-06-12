// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen, waitFor } from "storybook/test";
import { HelpTooltip } from "./HelpTooltip";
import { Label } from "./ui/label";

const meta = {
  component: HelpTooltip,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof HelpTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PlainText: Story = {
  args: {
    text: "Number of judge feedback loops the agent gets to refine its output.",
  },
  render: () => (
    <div className="flex items-center gap-1.5">
      <Label>Max iterations</Label>
      <HelpTooltip text="Number of judge feedback loops the agent gets to refine its output." />
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.hover(canvas.getByRole("button", { name: /more info/i }));
    await waitFor(async () => {
      await expect(screen.getAllByText(/feedback loops/i).length).toBeGreaterThan(0);
    });
  },
};

export const WithDocsLink: Story = {
  args: {
    text: "Reusable evaluation rules the judge applies to agent output.",
    docs: "criteria",
  },
  render: () => (
    <div className="flex items-center gap-1.5">
      <Label>Criteria</Label>
      <HelpTooltip
        text="Reusable evaluation rules the judge applies to agent output."
        docs="criteria"
      />
    </div>
  ),
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("link", { name: /learn more about this/i });
    await userEvent.hover(trigger);
    await waitFor(async () => {
      // The tooltip content also contains the visible "Learn more" link.
      await expect(screen.getAllByText(/evaluation rules/i).length).toBeGreaterThan(0);
    });
  },
};
