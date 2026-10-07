import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../server/src/auth";
import { getInstanceConfig, getSsoConfig } from "../server/src/config";
import { buildAdminConfigBindings, updateWorkerInstanceConfig, validateAdminConfigPatch } from "../server/src/api";
import { mapOidcIdentity, storeOidcSession } from "../server/src/oidc";
import type { SessionTokenClaims } from "../server/src/types";
import { apiRequest, ensureMigrated, TEST_SECRET } from "./helpers";

const ISSUER = "https://nickname.example";
const CLIENT_ID = "nickname-client";
let sequence = 0;

function identity() {
  const username = `nickname-user-${++sequence}`;
  return { issuer: ISSUER, subject: username, username, display_name: "来源昵称", email: null, email_verified: false };
}

async function token(localpart: string, authSource: "sso" | "local" = "sso") {
  const session: SessionTokenClaims = {
    v: 1, typ: "session", actor: `@${localpart}:local`, server_role: "user", auth_source: authSource,
    exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(),
  };
  return signToken(session, TEST_SECRET);
}

beforeAll(ensureMigrated);
beforeEach(() => {
  env.SSO_MODE = "optional";
  env.SSO_ISSUER = ISSUER;
  env.SSO_CLIENT_ID = CLIENT_ID;
  env.SSO_CLIENT_SECRET = "nickname-test-secret";
  env.SSO_NICKNAME_LOCKED = "0";
  env.EMBED_ORIGIN = undefined;
});
afterAll(() => {
  env.SSO_MODE = "disabled";
  env.SSO_ISSUER = "";
  env.SSO_CLIENT_ID = "";
  env.SSO_CLIENT_SECRET = undefined;
  env.SSO_NICKNAME_LOCKED = "0";
  env.EMBED_ORIGIN = undefined;
  vi.restoreAllMocks();
});

describe("SSO nickname policy", () => {
  it("allows local nickname edits and preserves them across later SSO logins", async () => {
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const saved = await apiRequest("/api/me/display-name", {
      method: "POST", headers: { Authorization: `Bearer ${await token(user.localpart)}` },
      body: JSON.stringify({ display_name: "自定昵称" }),
    });
    expect(saved.status).toBe(200);
    const next = await mapOidcIdentity(env, { ...source, display_name: "来源的新昵称" });
    expect(next).toMatchObject({ localpart: user.localpart, username: source.username, display_name: "自定昵称" });
  });

  it("preserves a local nickname edit that races with a provider refresh", async () => {
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const batch = env.DB.batch.bind(env.DB);
    const interleaved = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("UPDATE users SET display_name = ? WHERE localpart = ?").bind("刚保存的昵称", user.localpart).run();
      return batch(statements);
    });
    try {
      await mapOidcIdentity(env, { ...source, display_name: "来源的新昵称" });
      expect(await env.DB.prepare("SELECT display_name FROM users WHERE localpart = ?").bind(user.localpart).first())
        .toEqual({ display_name: "刚保存的昵称" });
    } finally {
      interleaved.mockRestore();
    }
  });

  it.each(["local", "sso"] as const)("rejects local nickname overrides through a %s session when linked to locked SSO", async (authSource) => {
    env.SSO_NICKNAME_LOCKED = "1";
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const saved = await apiRequest("/api/me/display-name", {
      method: "POST", headers: { Authorization: `Bearer ${await token(user.localpart, authSource)}` },
      body: JSON.stringify({ display_name: "不得覆盖" }),
    });
    expect(saved.status).toBe(403);
    expect(await saved.json()).toEqual({ error: "SSO_NICKNAME_LOCKED" });
    expect(await env.DB.prepare("SELECT display_name FROM users WHERE localpart = ?").bind(user.localpart).first())
      .toEqual({ display_name: source.display_name });
  });

  it("keeps local-only accounts editable in optional SSO mode", async () => {
    env.SSO_NICKNAME_LOCKED = "1";
    const username = `local-nickname-${++sequence}`;
    await env.DB.prepare("INSERT INTO users (localpart, display_name, status, created_at, server_role) VALUES (?, ?, 'active', ?, 'user')")
      .bind(username, username, Date.now()).run();
    const saved = await apiRequest("/api/me/display-name", {
      method: "POST", headers: { Authorization: `Bearer ${await token(username, "local")}` },
      body: JSON.stringify({ display_name: "本地用户昵称" }),
    });
    expect(saved.status).toBe(200);
  });

  it("forces provider synchronization in embedded locked mode even when the setting is off", async () => {
    env.SSO_MODE = "required";
    env.EMBED_ORIGIN = "https://host.example";
    expect(getSsoConfig(env)).toMatchObject({ session_locked: true, nickname_locked: true });
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const next = await mapOidcIdentity(env, { ...source, display_name: "来源的新昵称" });
    expect(next.display_name).toBe("来源的新昵称");
    expect(next.localpart).toBe(user.localpart);
    const saved = await apiRequest("/api/me/display-name", {
      method: "POST", headers: { Authorization: `Bearer ${await token(user.localpart)}` },
      body: JSON.stringify({ display_name: "不得覆盖" }),
    });
    expect(saved.status).toBe(403);
    const config = await apiRequest("/api/instance/config");
    expect(await config.json()).toMatchObject({ sso_session_locked: true, sso_nickname_locked: true });
  });

  it("reports the forced lock after an administrator submits an unlocked setting", async () => {
    env.SSO_MODE = "required";
    env.EMBED_ORIGIN = "https://host.example";
    const managedEnv = Object.assign(Object.create(env), { CF_ACCOUNT_ID: "test-account", CF_API_TOKEN: "test-token", CF_WORKER_NAME: "test-worker" });
    const response = await updateWorkerInstanceConfig(managedEnv, { SSO_NICKNAME_LOCKED: false }, async (_input, init) => {
      return Response.json({ success: true, result: init?.method === "PATCH" ? {} : { bindings: [] } });
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sso_session_locked: true, sso_nickname_locked: true });
  });

  it("validates the editable setting and serializes it as a plain deployment binding", async () => {
    const current = getInstanceConfig(env);
    expect(validateAdminConfigPatch({ sso_nickname_locked: true }, current)).toEqual({ SSO_NICKNAME_LOCKED: true });
    const invalid = validateAdminConfigPatch({ sso_nickname_locked: "1" }, current);
    expect(invalid).toBeInstanceOf(Response);
    expect((invalid as Response).status).toBe(400);
    expect(buildAdminConfigBindings([], { SSO_NICKNAME_LOCKED: true }))
      .toEqual([{ name: "SSO_NICKNAME_LOCKED", type: "plain_text", text: "1" }]);
    env.SSO_MODE = "disabled";
    env.SSO_NICKNAME_LOCKED = "1";
    expect(getSsoConfig(env).nickname_locked).toBe(false);
  });
});

describe("automatic SSO nickname refresh", () => {
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;
  beforeAll(async () => {
    const keys = await generateKeyPair("RS256", { modulusLength: 2048 });
    privateKey = keys.privateKey;
    publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig", kid: "nickname-key" };
  });

  it("retains a rotated refresh token when UserInfo is temporarily unavailable", async () => {
    env.SSO_NICKNAME_LOCKED = "1";
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const sessionToken = await token(user.localpart);
    await storeOidcSession(env, sessionToken, user.localpart, getSsoConfig(env), {
      access_token: "initial-access", token_type: "Bearer", id_token: "initial-id", refresh_token: "initial-refresh",
    });
    let refreshCount = 0;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
      if (url === `${ISSUER}/token`) {
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(refreshCount === 0 ? "initial-refresh" : "rotated-refresh-1");
        refreshCount++;
        return Response.json({ access_token: "current-access", token_type: "Bearer", refresh_token: `rotated-refresh-${refreshCount}` });
      }
      if (url === `${ISSUER}/userinfo`) return refreshCount === 1
        ? new Response("Temporarily unavailable", { status: 503 })
        : Response.json({ sub: source.subject, nickname: "恢复后的昵称", preferred_username: source.username });
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    try {
      const request = () => apiRequest("/api/auth/oidc/refresh", { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } });
      const unavailable = await request();
      expect(unavailable.status).toBe(502);
      const recovered = await request();
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ user: { display_name: "恢复后的昵称" } });
    } finally {
      fetcher.mockRestore();
    }
  });

  it.each([[true, false], [false, false], [true, true], [false, true]])(
    "refreshes verified UserInfo (new ID token: %s, mismatched subject: %s)", async (withIdToken, mismatched) => {
    env.SSO_NICKNAME_LOCKED = "1";
    const source = identity();
    const user = await mapOidcIdentity(env, source);
    const sessionToken = await token(user.localpart);
    const idToken = await new SignJWT({ nickname: "令牌中的旧昵称" })
      .setProtectedHeader({ alg: "RS256", kid: "nickname-key" }).setIssuer(ISSUER)
      .setSubject(source.subject).setAudience(CLIENT_ID).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await storeOidcSession(env, sessionToken, user.localpart, getSsoConfig(env), {
      access_token: "initial-access", token_type: "Bearer", id_token: idToken, refresh_token: "initial-refresh",
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
      if (url === `${ISSUER}/token`) return Response.json({
        access_token: "current-access", token_type: "Bearer", refresh_token: "rotated-refresh", ...(withIdToken ? { id_token: idToken } : {}),
      });
      if (url === `${ISSUER}/jwks`) return Response.json({ keys: [publicJwk] });
      if (url === `${ISSUER}/userinfo`) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer current-access");
        return Response.json({ sub: mismatched ? "another-subject" : source.subject, nickname: "当前来源昵称", name: "另一个名字", preferred_username: source.username });
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    try {
      const response = await apiRequest("/api/auth/oidc/refresh", {
        method: "POST", headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (mismatched) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "SSO_TOKEN_INVALID" });
        expect(await env.DB.prepare("SELECT display_name FROM users WHERE localpart = ?").bind(user.localpart).first())
          .toEqual({ display_name: source.display_name });
        return;
      }
      expect(response.status).toBe(200);
      const refreshed = await response.json() as { token: string; user: { username: string; display_name: string } };
      expect(refreshed.user).toMatchObject({ username: source.username, display_name: "当前来源昵称" });
      expect(await env.DB.prepare("SELECT display_name FROM users WHERE localpart = ?").bind(user.localpart).first())
        .toEqual({ display_name: "当前来源昵称" });
    } finally {
      fetcher.mockRestore();
    }
  });
});
