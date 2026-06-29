// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { CriteriaBadge, CriteriaKindBadge } from "./CriteriaBadge";

const meta = {
  title: "Components/CriteriaBadge",
  component: CriteriaBadge,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof CriteriaBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GateCriterion: Story = {
  args: {
    criterionId: "has_unit_tests",
    kind: "gate",
    evaluated: true,
    result: true,
    showStateLabel: true,
    link: false,
  },
};

export const ObservationCriterion: Story = {
  args: {
    criterionId: "uses_current_sdk",
    kind: "observation",
    evaluated: true,
    result: false,
    showStateLabel: true,
    link: false,
  },
};

export const KindBadges: Story = {
  args: {
    criterionId: "has_unit_tests",
    link: false,
  },
  render: () => (
    <div className="flex gap-2">
      <CriteriaKindBadge kind="gate" />
      <CriteriaKindBadge kind="observation" />
    </div>
  ),
};
