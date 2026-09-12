import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginOidcAuthorization,
  createOidcLoginCompletion,
  consumeOidcLoginCompletion,
  finishOidcAuthorization,
  mapOidcIdentity,
} from "../server/src/oidc";
import { getSsoConfig } from "../server/src/config";
import { ensureMigrated } from "./helpers";

const ISSUER = "https://identity.example";
const CLIENT_ID = "omew-test";
const CLIENT_SECRET = "client-secret";

describe("OMEW OIDC client", () => {
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;

  beforeAll(async () => {
    await ensureMigrated();
    env.SSO_MODE = "optional";
    env.SSO_ISSUER = ISSUER;
    env.SSO_CLIENT_ID = CLIENT_ID;
    env.SSO_CLIENT_SECRET = CLIENT_SECRET;
    const keys = await generateKeyPair("RS256", { modulusLength: 2048 });
    privateKey = keys.privateKey;
    publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig", kid: "provider-key" };
  });

  afterAll(() => {
    env.SSO_MODE = "disabled";
    env.SSO_ISSUER = "";
    env.SSO_CLIENT_ID = "";
    env.SSO_CLIENT_SECRET = undefined;
    env.SSO_PROVIDER_NAME = "";
  });

  it("completes discovery, PKCE, nonce, ID token verification, and UserInfo mapping", async () => {
    const request = new Request("http://localhost/api/auth/oidc/start?return_to=%2F");
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ["code"],
      scopes_supported: ["openid", "profile", "email"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      id_token_signing_alg_values_supported: ["RS256"],
    };

    const start = await beginOidcAuthorization(request, env, getSsoConfig(env), async (input) => {
      expect(String(input)).toBe(`${ISSUER}/.well-known/openid-configuration`);
      return Response.json(discovery);
    });
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("Location")!);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const nonce = location.searchParams.get("nonce")!;
    const state = location.searchParams.get("state")!;
    const cookie = start.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const idToken = await new SignJWT({
      nonce,
      name: "统一用户",
      email: "sso-user@example.com",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "provider-key" })
      .setIssuer(ISSUER)
      .setSubject("provider-user")
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const callback = new Request(`http://localhost/api/auth/oidc/callback?code=authorization-code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
    });
    const finish = await finishOidcAuthorization(callback, env, getSsoConfig(env), async (input, init) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(discovery);
      if (url === `${ISSUER}/token`) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Basic ${btoa("omew%2Dtest:client%2Dsecret")}`,
        );
        return Response.json({ access_token: "access-token", token_type: "Bearer", id_token: idToken });
      }
      if (url === `${ISSUER}/jwks.json`) return Response.json({ keys: [publicJwk] });
      if (url === `${ISSUER}/userinfo`) return Response.json({ sub: "provider-user", preferred_username: "sso-user" });
      throw new Error(`unexpected upstream URL: ${url}`);
    });

    expect(finish.return_to).toBe("/");
    expect(finish.identity).toMatchObject({
      issuer: ISSUER,
      subject: "provider-user",
      display_name: "sso-user",
      email: "sso-user@example.com",
      email_verified: true,
    });
  });

  it("maps one external subject to one local account and consumes completion codes once", async () => {
    const identity = {
      issuer: ISSUER,
      subject: "stable-subject",
      display_name: "Stable User",
      email: "stable@example.com",
      email_verified: true,
    };
    const first = await mapOidcIdentity(env, identity);
    const second = await mapOidcIdentity(env, identity);
    expect(second.localpart).toBe(first.localpart);
    const completion = await createOidcLoginCompletion(env, first.localpart);
    expect(await consumeOidcLoginCompletion(env, completion)).toBe(first.localpart);
    expect(await consumeOidcLoginCompletion(env, completion)).toBeNull();
  });

  it("negotiates client_secret_post when the provider does not publish Basic", async () => {
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks.json`,
      response_types_supported: ["code"],
      scopes_supported: ["openid", "profile", "email"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      id_token_signing_alg_values_supported: ["RS256"],
    };
    const start = await beginOidcAuthorization(new Request("http://localhost/api/auth/oidc/start?return_to=%2F"), env, getSsoConfig(env), async (input) => {
      expect(String(input)).toBe(`${ISSUER}/.well-known/openid-configuration`);
      return Response.json(discovery);
    });
    const location = new URL(start.headers.get("Location")!);
    const idToken = await new SignJWT({ nonce: location.searchParams.get("nonce"), name: "Post Client", email: "post@example.com", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "provider-key" })
      .setIssuer(ISSUER)
      .setSubject("post-subject")
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    let tokenBody: URLSearchParams | null = null;
    const cookie = start.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const finish = await finishOidcAuthorization(new Request(`http://localhost/api/auth/oidc/callback?code=post-code&state=${encodeURIComponent(location.searchParams.get("state")!)}`, { headers: { Cookie: cookie } }), env, getSsoConfig(env), async (input, init) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(discovery);
      if (url === `${ISSUER}/token`) {
        tokenBody = new URLSearchParams(String(init?.body || ""));
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        return Response.json({ access_token: "post-access", token_type: "Bearer", id_token: idToken });
      }
      if (url === `${ISSUER}/jwks.json`) return Response.json({ keys: [publicJwk] });
      if (url === `${ISSUER}/userinfo`) return Response.json({ sub: "post-subject", preferred_username: "post-user" });
      throw new Error(`unexpected upstream URL: ${url}`);
    });
    expect(tokenBody?.get("client_id")).toBe(CLIENT_ID);
    expect(tokenBody?.get("client_secret")).toBe(CLIENT_SECRET);
    expect(finish.identity.subject).toBe("post-subject");
  });
});
