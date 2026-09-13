import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginOidcAuthorization,
  createOidcLoginCompletion,
  consumeOidcLoginCompletion,
  finishOidcAuthorization,
  mapOidcIdentity,
  oidcLoginCompletionRedirect,
} from "../server/src/oidc";
import { getSsoConfig } from "../server/src/config";
import { apiRequest, ensureMigrated, sessionToken } from "./helpers";

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

    const start = await beginOidcAuthorization(request, env, getSsoConfig(env), async (input, init) => {
      expect(String(input)).toBe(`${ISSUER}/.well-known/openid-configuration`);
      expect(init?.redirect).toBe("manual");
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
      preferred_username: "sso-user",
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
      username: "sso-user",
      display_name: "sso-user",
      email: "sso-user@example.com",
      email_verified: true,
    });
  });

  it("rejects upstream redirects using the Workers-supported manual mode", async () => {
    const request = new Request("http://localhost/api/auth/oidc/start?return_to=%2F");

    await expect(beginOidcAuthorization(request, env, getSsoConfig(env), async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://redirected.example" } });
    })).rejects.toMatchObject({ code: "SSO_UPSTREAM_ERROR", status: 502 });
  });

  it("maps one external subject to one local account and consumes completion codes once", async () => {
    const identity = {
      issuer: ISSUER,
      subject: "stable-subject",
      username: "stable-user",
      display_name: "Stable User",
      email: "stable@example.com",
      email_verified: true,
    };
    const first = await mapOidcIdentity(env, identity);
    const second = await mapOidcIdentity(env, identity);
    expect(second.localpart).toBe(first.localpart);
    expect(second.username).toBe("stable-user");
    expect(second.display_name).toBe("Stable User");
    const completion = await createOidcLoginCompletion(env, first.localpart);
    expect(await consumeOidcLoginCompletion(env, completion)).toBe(first.localpart);
    expect(await consumeOidcLoginCompletion(env, completion)).toBeNull();
  });

  it("preserves a same-origin referrer for the completion document navigation", () => {
    const response = oidcLoginCompletionRedirect(
      new Request("http://localhost/api/auth/oidc/callback"),
      env,
      "/",
      "completion-code",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Location")).toBe("http://localhost/#sso_complete=completion-code");
  });

  it("establishes a constrained same-origin completion document for an embedded instance", async () => {
    env.EMBED_ORIGIN = "https://host.example";
    const response = oidcLoginCompletionRedirect(
      new Request("http://localhost/api/auth/oidc/callback"),
      env,
      '/path?label="unsafe&value',
      "completion-code",
    );
    env.EMBED_ORIGIN = undefined;

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors https://host.example");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain("http://localhost/path?label=%22unsafe&amp;value#sso_complete=completion-code");
    expect(html).not.toContain("http://localhost/path?label=%22unsafe&value#sso_complete=completion-code");
  });

  it("uses the provider username as the new local username and rejects collisions", async () => {
    const identity = {
      issuer: ISSUER,
      subject: "direct-username-subject",
      username: "direct-user",
      display_name: "Direct User",
      email: null,
      email_verified: false,
    };
    const mapped = await mapOidcIdentity(env, identity);
    expect(mapped.localpart).toBe("direct-user");
    expect(mapped.username).toBe("direct-user");

    await expect(mapOidcIdentity(env, {
      ...identity,
      subject: "conflicting-subject",
    })).rejects.toMatchObject({ code: "SSO_USERNAME_CONFLICT", status: 409 });
  });

  it("migrates a legacy SSO username without changing its referenced local identity", async () => {
    const localpart = "sso-legacy-user-identity";
    const subject = "legacy-user-subject";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (localpart, display_name, status, created_at, server_role, email, email_verified) VALUES (?, ?, 'active', ?, 'user', NULL, 0)",
      ).bind(localpart, "Legacy User", now),
      env.DB.prepare(
        "INSERT INTO oidc_identities (issuer, subject, localpart, username, created_at, last_login_at) VALUES (?, ?, ?, NULL, ?, ?)",
      ).bind(ISSUER, subject, localpart, now, now),
      env.DB.prepare(
        "INSERT INTO oidc_login_completions (code_hash, localpart, expires_at) VALUES (?, ?, ?)",
      ).bind("legacy-completion-reference", localpart, Math.floor(now / 1000) + 60),
    ]);

    const mapped = await mapOidcIdentity(env, {
      issuer: ISSUER,
      subject,
      username: "legacy-user",
      display_name: "Legacy User",
      email: null,
      email_verified: false,
    });

    expect(mapped).toMatchObject({ localpart, username: "legacy-user" });
    expect(await env.DB.prepare("SELECT localpart, username FROM oidc_identities WHERE issuer = ? AND subject = ?")
      .bind(ISSUER, subject).first()).toEqual({ localpart, username: "legacy-user" });
    expect(await env.DB.prepare("SELECT localpart FROM oidc_login_completions WHERE code_hash = ?")
      .bind("legacy-completion-reference").first()).toEqual({ localpart });

    const adminToken = await sessionToken("@oidc-alias-admin:local", "owner");
    const users = await apiRequest("/api/admin/users", { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(users.status).toBe(200);
    expect((await users.json() as { users: Array<{ localpart: string; username: string }> }).users)
      .toContainEqual(expect.objectContaining({ localpart, username: "legacy-user" }));

    const profile = await apiRequest(`/api/users/${encodeURIComponent(`@${localpart}:local`)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(await profile.json()).toMatchObject({ actor: `@${localpart}:local`, username: "legacy-user" });

    await env.DB.prepare(
      "UPDATE users SET status = 'banned', banned_by = ?, banned_at = ?, banned_until = NULL WHERE localpart = ?",
    ).bind("@oidc-alias-admin:local", now, localpart).run();
    const bans = await apiRequest("/api/admin/bans", { headers: { Authorization: `Bearer ${adminToken}` } });
    expect((await bans.json() as { entries: Array<{ actor: string; username: string }> }).entries)
      .toContainEqual(expect.objectContaining({ actor: `@${localpart}:local`, username: "legacy-user" }));
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
