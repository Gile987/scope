// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { Switch } from "./switch";
import { Label } from "./label";

const meta = {
  component: Switch,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      <Switch id="enrich" {...args} />
      <Label htmlFor="enrich">Enable enrichment</Label>
    </div>
  ),
  play: async ({ canvas }) => {
    const sw = canvas.getByRole("switch");
    await expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    await expect(sw).toBeChecked();
  },
};

export const Checked: Story = {
  args: { defaultChecked: true },
  render: (args) => <Switch {...args} />,
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => <Switch {...args} />,
};
