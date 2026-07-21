// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen } from "storybook/test";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { UserMenu } from "./UserMenu";

/** Build an AuthContext value so stories are deterministic without MSAL. */
function authValue(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    account: null,
    user: null,
    isAuthenticated: false,
    isReady: true,
    login: async () => {},
    logout: async () => {},
    ...overrides,
  };
}

const signedIn = authValue({
  isAuthenticated: true,
  user: {
    name: "Alice Anderson",
    username: "alice@entralocal.dev",
    subject: "alice-subject",
  },
});

const signedOut = authValue({ isAuthenticated: false, user: null });

const meta = {
  component: UserMenu,
  tags: ["ai-generated"],
} satisfies Meta<typeof UserMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  decorators: [
    (Story) => (
      <AuthContext.Provider value={signedIn}>
        <Story />
      </AuthContext.Provider>
    ),
  ],
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: "Account menu" });
    await expect(trigger).toBeVisible();
    // Initials derived from the display name.
    await expect(trigger).toHaveTextContent("AA");
    await userEvent.click(trigger);
    await expect(
      await screen.findByText("alice@entralocal.dev"),
    ).toBeVisible();
    await expect(screen.getByText("Sign out")).toBeVisible();
  },
};

export const SignedOut: Story = {
  decorators: [
    (Story) => (
      <AuthContext.Provider value={signedOut}>
        <Story />
      </AuthContext.Provider>
    ),
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Sign in" })).toBeVisible();
  },
};
