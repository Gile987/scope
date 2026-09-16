// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { AuthError } from "shared";
import { apiRoute } from "../openapi/api-route.js";
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
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/users/me",
    tags: ["Users"],
    summary: "Get the authenticated user's identity",
    security: [{ bearerAuth: [] }],
    description: "Pass login=true after an IdP callback to JIT-enroll the user, refresh their profile and lastLoginAt, apply bootstrap-admin rules, and warm the access cache. Omit login (or use false) for a read-only cached identity lookup. Login-marked GET requests have side effects and must not be prefetched or HTTP-cached.",
    query: z.object({
      login: z.enum(["true", "false"]).optional(),
    }),
    response: UserMeResponseSchema,
    errorResponses: {
      400: { description: "Invalid login query parameter" },
      401: { description: "Not authenticated" },
      403: { description: "User is not enrolled or is disabled" },
      503: { description: "Authentication service unavailable" },
    },
    handler: async (req, res) => {
      if (!req.auth) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const resolver = ctx.userAccessResolver;
      if (!resolver) {
        throw new AuthError("service_unavailable", "Authentication service unavailable");
      }
      // Express also dispatches HEAD to GET handlers; HEAD must never enroll.
      const user = req.method === "GET" && req.query.login === "true"
        ? await resolver.enrollOnLogin(req.auth.identity, req.auth.token)
        : await resolver.resolveExisting(req.auth.identity);
      req.user = user;
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
