// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { apiRoute } from "../openapi/api-route.js";
import { getUser } from "../auth/types.js";
import type { RouteContext } from "../route-context.js";

extendZodWithOpenApi(z);

const UserMeResponseSchema = z
  .object({
    id: z.string(),
    role: z.string().optional(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    idp: z.string().optional(),
    idpTenant: z.string().optional(),
  })
  .openapi("UserMeResponse");

export function registerUsersRoutes(ctx: RouteContext): void {
  // Current user's identity. Resolved from the bearer token by the auth
  // middleware. Anonymous callers get 401 — this endpoint is meaningless
  // without an identity (still non-breaking, since it is a brand-new route).
  //
  // The profile (email/displayName) is sourced through the same enrichment
  // seam as authentication; today that is the token claims already on
  // `req.user`, so a future Graph-backed `/me` is a drop-in replacement.
  // No permissions are returned yet — that is part of the RBAC milestone.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/users/me",
    tags: ["Users"],
    summary: "Get the authenticated user's identity",
    response: UserMeResponseSchema,
    errorResponses: {
      401: { description: "Not authenticated" },
      403: { description: "User is disabled" },
      503: { description: "Authentication service unavailable" },
    },
    handler: async (req, res) => {
      const user = getUser(req);
      if (!user.isAuthenticated) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      res.json({
        id: user.id,
        role: user.role,
        email: user.email,
        displayName: user.displayName,
        idp: user.idp,
        idpTenant: user.idpTenant,
      });
    },
  });
}
