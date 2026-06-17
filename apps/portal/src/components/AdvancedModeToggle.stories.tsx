// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { AdvancedModeToggle } from "./AdvancedModeToggle";

const meta = {
  component: AdvancedModeToggle,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof AdvancedModeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  args: { checked: false, onCheckedChange: () => {} },
  render: (args) => {
    const [checked, setChecked] = useState(args.checked);
    return (
      <div className="p-6">
        <AdvancedModeToggle
          {...args}
          checked={checked}
          onCheckedChange={setChecked}
        />
      </div>
    );
  },
  play: async ({ canvas }) => {
    const sw = canvas.getByRole("switch", { name: /toggle advanced options/i });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(canvas.getByText(/^Advanced$/)).toBeVisible();
  },
};

export const On: Story = {
  args: { checked: true, onCheckedChange: () => {} },
  render: (args) => {
    const [checked, setChecked] = useState(args.checked);
    return (
      <div className="p-6">
        <AdvancedModeToggle
          {...args}
          checked={checked}
          onCheckedChange={setChecked}
        />
      </div>
    );
  },
  play: async ({ canvas }) => {
    const sw = canvas.getByRole("switch", { name: /toggle advanced options/i });
    await expect(sw).toHaveAttribute("aria-checked", "true");
  },
};

export const ClickFlipsState: Story = {
  args: { checked: false, onCheckedChange: () => {} },
  render: (args) => {
    const [checked, setChecked] = useState(args.checked);
    return (
      <div className="p-6">
        <AdvancedModeToggle
          {...args}
          checked={checked}
          onCheckedChange={setChecked}
        />
      </div>
    );
  },
  play: async ({ canvas }) => {
    const sw = canvas.getByRole("switch", { name: /toggle advanced options/i });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(async () => {
      await expect(sw).toHaveAttribute("aria-checked", "true");
    });
  },
};

export const CustomLabel: Story = {
  args: {
    checked: false,
    onCheckedChange: () => {},
    label: "Expert mode",
    helpText: "Show every knob and dial.",
  },
  render: (args) => {
    const [checked, setChecked] = useState(args.checked);
    return (
      <div className="p-6">
        <AdvancedModeToggle
          {...args}
          checked={checked}
          onCheckedChange={setChecked}
        />
      </div>
    );
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Expert mode")).toBeVisible();
  },
};
