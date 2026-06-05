// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen } from "storybook/test";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./select";

const meta = {
  component: Select,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[220px]" aria-label="Model">
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="claude-haiku-4.5">claude-haiku-4.5</SelectItem>
          <SelectItem value="claude-sonnet-4.5">claude-sonnet-4.5</SelectItem>
          <SelectItem value="gpt-5.2">gpt-5.2</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("combobox"));
    await expect(await screen.findByRole("listbox")).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "gpt-5.2" }));
    await expect(canvas.getByText("gpt-5.2")).toBeVisible();
  },
};
