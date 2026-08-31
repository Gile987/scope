// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { AuthError, type AuthProvider, type VerifiedIdentity } from "./types.js";

/** The key material accepted by {@link jwtVerify} (remote JWKS, or a local key in tests). */
type VerifyKey = Parameters<typeof jwtVerify>[1];

/** Default Entra v2.0 per-tenant issuer template. `{tenantid}` is substituted. */
const DEFAULT_ISSUER_TEMPLATE =
  "https://login.microsoftonline.com/{tenantid}/v2.0";

export interface EntraIdAuthProviderOptions {
  /**
   * Expected audience — the API app registration client id (a GUID) and/or its
   * `api://<client-id>` Application ID URI. Pass an array to accept both.
   */
  audience: string | string[];
  /**
   * OIDC authority, e.g. `https://login.microsoftonline.com/common` or
   * `.../organizations`. Used to derive the JWKS endpoint. Multi-tenant: any
   * tenant is accepted and the issuer is validated per-tenant against
   * {@link EntraIdAuthProviderOptions.issuerTemplate}.
   */
  authority: string;
  /** Explicit JWKS URI. Defaults to `${authority}/discovery/v2.0/keys`. */
  jwksUri?: string;
  /** Issuer template with a `{tenantid}` placeholder. Defaults to Entra v2.0. */
  issuerTemplate?: string;
  /** Injectable key resolver for tests (defaults to a cached remote JWKS). */
  jwks?: VerifyKey;
}

/**
 * {@link AuthProvider} backed by Microsoft Entra ID.
 *
 * Verifies RS256 access tokens against the tenant JWKS, checks audience and a
 * per-tenant issuer (no `tid` pinning — any tenant is accepted), and extracts
 * identity claims. Never inspects roles/groups.
 */
export class EntraIdAuthProvider implements AuthProvider {
  readonly id = "entra";

  private readonly audience: string | string[];
  private readonly issuerTemplate: string;
  private readonly jwks: VerifyKey;

  constructor(options: EntraIdAuthProviderOptions) {
    this.audience = options.audience;
    this.issuerTemplate = options.issuerTemplate ?? DEFAULT_ISSUER_TEMPLATE;

    const jwksUri =
      options.jwksUri ??
      `${options.authority.replace(/\/+$/, "")}/discovery/v2.0/keys`;
    this.jwks = options.jwks ?? createRemoteJWKSet(new URL(jwksUri));
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    const payload = await this.verifySignatureAndClaims(token);

    const idpTenant = asString(payload.tid);
    if (!idpTenant) {
      throw new AuthError("missing_claim", "Token is missing the `tid` claim");
    }
    const idpSubject = asString(payload.oid);
    if (!idpSubject) {
      throw new AuthError("missing_claim", "Token is missing the `oid` claim");
    }

    // Multi-tenant issuer validation: any tenant is accepted, but the issuer
    // must match the per-tenant v2.0 template for the tenant the token claims.
    const expectedIssuer = this.issuerTemplate.replace("{tenantid}", idpTenant);
    if (payload.iss !== expectedIssuer) {
      throw new AuthError(
        "invalid_issuer",
        `Unexpected token issuer: ${String(payload.iss)}`,
      );
    }

    const email =
      asString(payload.email) ?? asString(payload.preferred_username);
    const displayName = asString(payload.name);
    const emailVerified =
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : undefined;

    return {
      idp: this.id,
      idpTenant,
      idpSubject,
      email,
      displayName,
      emailVerified,
    };
  }

  private async verifySignatureAndClaims(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        audience: this.audience,
        algorithms: ["RS256"],
      });
      return payload;
    } catch (err) {
      const code = asString((err as { code?: unknown }).code) ?? "";
      const message = err instanceof Error ? err.message : String(err);

      if (code === "ERR_JWT_EXPIRED") {
        throw new AuthError("expired_token", "Access token has expired");
      }
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        // jose raises this for a failed audience (and other) claim checks.
        throw new AuthError("invalid_audience", message);
      }
      throw new AuthError(
        "invalid_token",
        `Token verification failed: ${message}`,
      );
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
