import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../server/src/api";
import { typeToKind } from "../server/src/types";
import { ensureMigrated } from "./helpers";

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
    env.USE_ART_ASSETS = undefined;
    env.USE_BUILTIN_EMOTES = undefined;
  });

  it("initializes and exposes the configured root stronghold", async () => {
    const configResponse = await apiRequest("/api/instance/config");
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({
      instance_mode: "single",
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
});
