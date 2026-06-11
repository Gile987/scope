// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { GateCompatibilityPicker } from "./GateCompatibilityPicker";
import type { GateId } from "@/lib/gates";

const meta = {
  title: "Components/GateCompatibilityPicker",
  component: GateCompatibilityPicker,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof GateCompatibilityPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

function StatefulExample() {
  const [gates, setGates] = useState<GateId[] | undefined>(["select", "build"]);
  return <GateCompatibilityPicker value={gates} onChange={setGates} />;
}

export const SelectAndBuild: Story = {
  args: {
    value: ["select", "build"],
    onChange: () => {},
  },
  render: () => <StatefulExample />,
};

export const AllGates: Story = {
  args: {
    value: undefined,
    onChange: () => {},
  },
};
