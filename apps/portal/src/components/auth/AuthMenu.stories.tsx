// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { MsalProvider } from "@azure/msal-react";
import { AuthProvider } from "@/auth/AuthContext";
import { msalInstance } from "@/auth/msal";
import type { AuthenticatedUser } from "@/auth/types";
import { AuthMenu } from "./AuthMenu";

const USER: AuthenticatedUser = {
  id: "story-user",
  role: "user",
  permissions: ["scope/run:read", "scope/run:write"],
  name: "Story User",
  email: "story-user@scope.local",
  idp: "entra",
};

const ADMIN: AuthenticatedUser = {
  id: "story-admin",
  role: "admin",
  permissions: ["scope/*:admin"],
  name: "Story Admin",
  email: "story-admin@scope.local",
  idp: "entra",
};

const meta = {
  component: AuthMenu,
  tags: ["ai-generated", "needs-work"],
  decorators: [
    (Story) => (
      <MsalProvider instance={msalInstance}>
        <div className="flex justify-end p-4">
          <Story />
        </div>
      </MsalProvider>
    ),
  ],
} satisfies Meta<typeof AuthMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const User: Story = {
  render: () => (
    <AuthProvider initialUser={USER}>
      <AuthMenu />
    </AuthProvider>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("user")).toBeVisible();
  },
};

export const Admin: Story = {
  render: () => (
    <AuthProvider initialUser={ADMIN}>
      <AuthMenu />
    </AuthProvider>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("admin")).toBeVisible();
  },
};
