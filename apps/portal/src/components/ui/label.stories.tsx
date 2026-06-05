// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Label } from "./label";
import { Input } from "./input";

const meta = {
  component: Label,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Scenario name" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Scenario name")).toBeVisible();
  },
};

export const WithInput: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="scenario">Scenario name</Label>
      <Input id="scenario" placeholder="hello-world-express" />
    </div>
  ),
};
