// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import { EntraIdAuthProvider } from "./entra.js";
import { AuthError } from "./types.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const SUBJECT = "22222222-2222-2222-2222-222222222222";
const AUDIENCE = "api-client-id";
const AUTHORITY = "https://login.microsoftonline.com/common";

let privateKey: KeyLike;
let publicKey: KeyLike;
let wrongPrivateKey: KeyLike;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function basePayload(): Record<string, unknown> {
  const now = nowSeconds();
  return {
    aud: AUDIENCE,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    oid: SUBJECT,
    name: "Ada Lovelace",
    preferred_username: "ada@example.com",
    email_verified: true,
    iat: now,
    nbf: now,
    exp: now + 3600,
  };
}

async function sign(
  payload: Record<string, unknown>,
  key: KeyLike = privateKey,
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256" }).sign(key);
}

function makeProvider(): EntraIdAuthProvider {
  return new EntraIdAuthProvider({
    authority: AUTHORITY,
    audience: AUDIENCE,
    jwks: async () => publicKey,
  });
}

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  }));
  ({ privateKey: wrongPrivateKey } = await generateKeyPair("RS256", {
    extractable: true,
  }));
});

describe("EntraIdAuthProvider.verifyAccessToken", () => {
  it("verifies a valid token and extracts identity claims", async () => {
    const token = await sign(basePayload());
    const identity = await makeProvider().verifyAccessToken(token);

    expect(identity).toEqual({
      idp: "entra",
      idpTenant: TENANT,
      idpSubject: SUBJECT,
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      emailVerified: true,
    });
  });

  it("prefers the `email` claim over `preferred_username`", async () => {
    const token = await sign({
      ...basePayload(),
      email: "ada.primary@example.com",
    });
    const identity = await makeProvider().verifyAccessToken(token);
    expect(identity.email).toBe("ada.primary@example.com");
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const token = await sign(basePayload(), wrongPrivateKey);
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_token" },
    );
  });

  it.each(["ERR_JWKS_TIMEOUT", "ECONNRESET"])(
    "retries one transient JWKS retrieval failure (%s)",
    async (code) => {
      const token = await sign(basePayload());
      const jwks = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("JWKS unavailable"), { code }))
        .mockResolvedValueOnce(publicKey);
      const provider = new EntraIdAuthProvider({
        authority: AUTHORITY,
        audience: AUDIENCE,
        jwks,
      });

      await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({
        idpSubject: SUBJECT,
      });
      expect(jwks).toHaveBeenCalledTimes(2);
    },
  );

  it("returns service_unavailable after the bounded JWKS retry is exhausted", async () => {
    const token = await sign(basePayload());
    const error = Object.assign(new Error("JWKS request timed out"), {
      code: "ERR_JWKS_TIMEOUT",
    });
    const jwks = vi.fn().mockRejectedValue(error);
    const provider = new EntraIdAuthProvider({
      authority: AUTHORITY,
      audience: AUDIENCE,
      jwks,
    });

    await expect(provider.verifyAccessToken(token)).rejects.toMatchObject({
      name: "AuthError",
      code: "service_unavailable",
    });
    expect(jwks).toHaveBeenCalledTimes(2);
  });

  it("does not retry a JWKS key-selection failure", async () => {
    const token = await sign(basePayload());
    const error = Object.assign(new Error("no applicable key found"), {
      code: "ERR_JWKS_NO_MATCHING_KEY",
    });
    const jwks = vi.fn().mockRejectedValue(error);
    const provider = new EntraIdAuthProvider({
      authority: AUTHORITY,
      audience: AUDIENCE,
      jwks,
    });

    await expect(provider.verifyAccessToken(token)).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_token",
    });
    expect(jwks).toHaveBeenCalledOnce();
  });

  it("rejects an expired token", async () => {
    const now = nowSeconds();
    const token = await sign({
      ...basePayload(),
      iat: now - 7200,
      nbf: now - 7200,
      exp: now - 3600,
    });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "expired_token" },
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign({ ...basePayload(), aud: "some-other-api" });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_audience" },
    );
  });

  it("rejects a token whose issuer does not match its tenant", async () => {
    const token = await sign({
      ...basePayload(),
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_issuer" },
    );
  });

  it("rejects a token missing the `oid` claim", async () => {
    const payload = basePayload();
    delete payload.oid;
    const token = await sign(payload);
    await expect(
      makeProvider().verifyAccessToken(token),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { code: "missing_claim" },
    );
  });

  it("accepts any tenant (multi-tenant) as long as issuer matches tid", async () => {
    const token = await sign({
      ...basePayload(),
      tid: OTHER_TENANT,
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    const identity = await makeProvider().verifyAccessToken(token);
    expect(identity.idpTenant).toBe(OTHER_TENANT);
  });

  it("validates a self-hosted issuer via issuerTemplate (entra-local)", async () => {
    // The entra-local emulator mints `iss: https://localhost:8443/{tid}/v2.0`,
    // which does not match the Entra-cloud default template.
    const provider = new EntraIdAuthProvider({
      authority: "https://localhost:8443/common",
      audience: AUDIENCE,
      issuerTemplate: "https://localhost:8443/{tenantid}/v2.0",
      jwks: async () => publicKey,
    });
    const token = await sign({
      ...basePayload(),
      iss: `https://localhost:8443/${TENANT}/v2.0`,
    });
    const identity = await provider.verifyAccessToken(token);
    expect(identity.idpTenant).toBe(TENANT);

    // The same token is rejected by a provider using the cloud default template.
    await expect(
      makeProvider().verifyAccessToken(token),
    ).rejects.toMatchObject({ name: "AuthError", code: "invalid_issuer" });
  });
});
