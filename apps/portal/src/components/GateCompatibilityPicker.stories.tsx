// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { GateCompatibilityPicker } from "./GateCompatibilityPicker";
import { GATE_ORDER, type GateId } from "@/lib/gates";

const meta = {
  title: "Components/GateCompatibilityPicker",
  component: GateCompatibilityPicker,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof GateCompatibilityPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

function StatefulExample({
  initial,
  lockedGates,
}: {
  initial: GateId[];
  lockedGates?: GateId[];
}) {
  const [gates, setGates] = useState<GateId[] | undefined>(initial);
  return (
    <GateCompatibilityPicker value={gates} onChange={setGates} lockedGates={lockedGates} />
  );
}

export const SelectAndBuild: Story = {
  args: { value: ["select", "build"], onChange: () => {} },
  render: () => <StatefulExample initial={["select", "build"]} />,
};

export const AllGatesSelected: Story = {
  args: { value: [...GATE_ORDER], onChange: () => {} },
  render: () => <StatefulExample initial={[...GATE_ORDER]} />,
};

export const LockedBuild: Story = {
  args: { value: ["build", "test"], onChange: () => {}, lockedGates: ["build"] },
  render: () => <StatefulExample initial={["build", "test"]} lockedGates={["build"]} />,
};
