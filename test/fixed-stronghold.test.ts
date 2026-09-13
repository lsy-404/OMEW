import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker, { ensureRegisteredActorInSingleStronghold } from "../server/src/api";
import { getInstanceConfig } from "../server/src/config";
import { mapOidcIdentity } from "../server/src/oidc";
import { typeToKind } from "../server/src/types";
import { ensureMigrated, loginAs, registerUser } from "./helpers";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(`http://local${path}`, { ...init, headers }), env);
}

describe("single stronghold instance mode", () => {
  beforeAll(async () => {
    await ensureMigrated();
    env.INSTANCE_MODE = "single";
    env.ROOT_STRONGHOLD = "medium5";
    env.INSTANCE_NAME = "论坛";
    env.EMBED_ORIGIN = "https://stardustinfinity.top";
    env.USE_ART_ASSETS = "0";
    env.USE_BUILTIN_EMOTES = "0";
    await env.STRONGHOLD_DO.getByName("root-id").ensureConfigWithDefaults(
      "root-id",
      "Configured root",
      "public",
      "@system:local",
      "",
      "medium5",
    );
  });

  afterAll(async () => {
    const stronghold = env.STRONGHOLD_DO.getByName("root-id");
    const rooms = await stronghold.listRoomsForDeletion();
    await Promise.all(
      rooms.map((room) => env.ROOM_DO.getByName(`root-id/${typeToKind(room.type)}/${room.res_id}`).purgeForStrongholdDeletion()),
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stronghold_member_index WHERE stronghold_id = ?").bind("root-id"),
      env.DB.prepare("DELETE FROM stronghold_slug_index WHERE stronghold_id = ?").bind("root-id"),
      env.DB.prepare("DELETE FROM stronghold_directory_index WHERE stronghold_id = ?").bind("root-id"),
    ]);
    await stronghold.purgeForStrongholdDeletion();
    env.INSTANCE_MODE = "multi";
    env.ROOT_STRONGHOLD = "";
    env.INSTANCE_NAME = undefined;
    env.EMBED_ORIGIN = undefined;
    env.USE_ART_ASSETS = undefined;
    env.USE_BUILTIN_EMOTES = undefined;
  });

  it("initializes and exposes the configured root stronghold", async () => {
    const configResponse = await apiRequest("/api/instance/config");
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({
      instance_mode: "single",
      instance_name: "论坛",
      root_stronghold: { id: "root-id", name: "Configured root", slug: "medium5" },
      logo_url: null,
      emotes_enabled: true,
      builtin_emotes_enabled: false,
      reactions_enabled: true,
      art_assets_enabled: false,
    });

    const directoryResponse = await apiRequest("/api/directory");
    expect(directoryResponse.status).toBe(200);
    expect(await directoryResponse.json()).toMatchObject({
      strongholds: [{ id: "root-id", name: "Configured root", slug: "medium5" }],
    });

    const resolveResponse = await apiRequest("/api/resolve/a/medium5");
    expect(resolveResponse.status).toBe(200);
    expect(await resolveResponse.json()).toEqual({ stronghold_id: "root-id" });

    const otherSlugResponse = await apiRequest("/api/resolve/a/other-place");
    expect(otherSlugResponse.status).toBe(404);

    const strongholdResponse = await apiRequest("/api/stronghold/root-id/config");
    expect(strongholdResponse.status).toBe(200);
    expect((await strongholdResponse.json()).name).toBe("Configured root");
  });

  it("rejects creating, deleting, or addressing another stronghold", async () => {
    const createResponse = await apiRequest("/api/strongholds", {
      method: "POST",
      body: JSON.stringify({ name: "other" }),
    });
    expect(createResponse.status).toBe(403);
    expect(await createResponse.json()).toEqual({ error: "INSTANCE_SINGLE_STRONGHOLD" });

    const otherStrongholdResponse = await apiRequest("/api/stronghold/other/config");
    expect(otherStrongholdResponse.status).toBe(404);

    const deleteResponse = await apiRequest("/api/stronghold/root-id", { method: "DELETE" });
    expect(deleteResponse.status).toBe(403);
    expect(await deleteResponse.json()).toEqual({ error: "INSTANCE_SINGLE_STRONGHOLD" });
  });

  it("keeps the deployment configuration repairable when the root is missing", async () => {
    env.ROOT_STRONGHOLD = "";
    const configResponse = await apiRequest("/api/instance/config");
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({ instance_mode: "single", root_stronghold: null });
    const directoryResponse = await apiRequest("/api/directory");
    expect(directoryResponse.status).toBe(503);
    expect(await directoryResponse.json()).toEqual({ error: "INSTANCE_ROOT_NOT_CONFIGURED" });
    env.ROOT_STRONGHOLD = "medium5";
  });

  it("enforces the deployment emote switch at the API boundary", async () => {
    env.ENABLE_EMOTES = "0";
    const response = await apiRequest("/api/emotes");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "FEATURE_DISABLED" });
    env.ENABLE_EMOTES = undefined;
  });

  it("adds a local registration to the configured root before returning success", async () => {
    const response = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: "singlelocaljoin",
        password: "password123",
        ownership_pubkey: "test-pubkey",
        ownership_ciphertext: "test-ciphertext",
      }),
    });

    expect(response.status).toBe(200);
    const registered = await response.clone().json() as { token: string };
    const stronghold = env.STRONGHOLD_DO.getByName("root-id");
    expect(await stronghold.getMember("@singlelocaljoin:local")).toMatchObject({
      actor: "@singlelocaljoin:local",
      role: "member",
    });
    const mine = await apiRequest("/api/me/strongholds", {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
    expect(await mine.json() as Array<{ id: string }>)
      .toContainEqual(expect.objectContaining({ id: "root-id" }));
  });

  it("uses the same idempotent membership path for an OIDC first registration", async () => {
    const mapped = await mapOidcIdentity(env, {
      issuer: "https://single-oidc.example",
      subject: "single-oidc-subject",
      username: "singleoidcjoin",
      display_name: "Single OIDC Join",
      email: null,
      email_verified: false,
    });
    const actor = `@${mapped.localpart}:local`;
    const config = getInstanceConfig(env);
    const root = { id: "root-id", name: "Configured root", slug: "medium5" };

    expect(await ensureRegisteredActorInSingleStronghold(env, config, root, actor)).toBeNull();
    expect(await ensureRegisteredActorInSingleStronghold(env, config, root, actor)).toBeNull();

    const members = await env.STRONGHOLD_DO.getByName("root-id").listMembers();
    expect(members.filter((member) => member.actor === actor)).toHaveLength(1);
  });

  it("does not return a registered account when a single instance has no usable root", async () => {
    env.ROOT_STRONGHOLD = "";
    const response = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({
        username: "rootmissingjoin",
        password: "password123",
        ownership_pubkey: "test-pubkey",
        ownership_ciphertext: "test-ciphertext",
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "INSTANCE_ROOT_NOT_CONFIGURED" });
    expect(await env.DB.prepare("SELECT localpart FROM users WHERE localpart = ?").bind("rootmissingjoin").first()).toBeNull();
    env.ROOT_STRONGHOLD = "medium5";
  });

  it("allows iframe entry and OIDC completion while rejecting direct document navigation", async () => {
    const embedded = await worker.fetch(new Request("https://omew.stardustinfinity.top/", {
      headers: {
        Referer: "https://stardustinfinity.top/",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "cross-site",
      },
    }), env);
    expect(embedded.status).not.toBe(403);

    const sameOriginContinuation = await worker.fetch(new Request("https://omew.stardustinfinity.top/", {
      headers: {
        Referer: "https://omew.stardustinfinity.top/api/auth/oidc/callback?code=example&state=example",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "same-origin",
      },
    }), env);
    expect(sameOriginContinuation.status).not.toBe(403);

    const crossSiteCallbackContinuation = await worker.fetch(new Request("https://omew.stardustinfinity.top/", {
      headers: {
        Referer: "https://omew.stardustinfinity.top/api/auth/oidc/callback?code=example&state=example",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "cross-site",
      },
    }), env);
    expect(crossSiteCallbackContinuation.status).not.toBe(403);

    const unrelatedCrossSiteContinuation = await worker.fetch(new Request("https://omew.stardustinfinity.top/", {
      headers: {
        Referer: "https://omew.stardustinfinity.top/unrelated",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "cross-site",
      },
    }), env);
    expect(unrelatedCrossSiteContinuation.status).toBe(403);

    const direct = await worker.fetch(new Request("https://omew.stardustinfinity.top/", {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" },
    }), env);
    expect(direct.status).toBe(403);
    expect(await direct.text()).toContain("仅在星尘粉丝站内提供");
  });

  it("keeps builtin emotes enabled when art assets are disabled for StarDust", async () => {
    env.ENABLE_EMOTES = "1";
    env.USE_BUILTIN_EMOTES = "1";
    env.USE_ART_ASSETS = "0";

    try {
      const configResponse = await apiRequest("/api/instance/config");
      expect(configResponse.status).toBe(200);
      expect(await configResponse.json()).toMatchObject({
        emotes_enabled: true,
        builtin_emotes_enabled: true,
        art_assets_enabled: false,
      });

      const username = `stardust-emoji-${Date.now()}`;
      const registerResponse = await registerUser({
        username,
        password: "password123",
        ownership_pubkey: "test-pubkey",
        ownership_ciphertext: "test-ciphertext-blob",
      });
      expect(registerResponse.status).toBe(200);
      const token = await loginAs(username);
      const emotesResponse = await apiRequest("/api/emotes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(emotesResponse.status).toBe(200);
      expect((await emotesResponse.json()).packs).toEqual(expect.any(Array));
    } finally {
      env.ENABLE_EMOTES = undefined;
      env.USE_BUILTIN_EMOTES = undefined;
      env.USE_ART_ASSETS = undefined;
    }
  });

  it("locks logout for the embedded required-SSO forum", async () => {
    env.SSO_MODE = "required";
    const config = await apiRequest("/api/instance/config");
    expect(await config.json()).toMatchObject({ sso_session_locked: true });

    const logout = await apiRequest("/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(403);
    expect(await logout.json()).toEqual({ error: "LOGOUT_DISABLED" });
    env.SSO_MODE = "disabled";
  });
});
