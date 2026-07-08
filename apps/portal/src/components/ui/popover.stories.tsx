// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen } from "storybook/test";
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import { Button } from "./button";

const meta = {
  component: Popover,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open filter</Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <p className="text-sm font-medium">Popover content</p>
        <p className="text-sm text-muted-foreground">
          Stays open until you click outside or press Escape.
        </p>
      </PopoverContent>
    </Popover>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /open filter/i }));
    await expect(await screen.findByText("Popover content")).toBeVisible();
  },
};
