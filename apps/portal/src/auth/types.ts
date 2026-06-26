// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Permission, UserRole } from "./permissions";

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  permissions: Permission[];
  name?: string;
  email?: string;
  idp?: string;
  idpTenant?: string;
  idpSubject?: string;
  isService?: boolean;
}

export type MeResponse = AuthenticatedUser;
