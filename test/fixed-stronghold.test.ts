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

describe("fixed stronghold deployment mode", () => {
  beforeAll(async () => {
    await ensureMigrated();
    env.FIXED_STRONGHOLD = "medium5";
  });

  afterAll(async () => {
    const stronghold = env.STRONGHOLD_DO.getByName("medium5");
    const rooms = await stronghold.listRoomsForDeletion();
    await Promise.all(
      rooms.map((room) => env.ROOM_DO.getByName(`medium5/${typeToKind(room.type)}/${room.res_id}`).purgeForStrongholdDeletion()),
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stronghold_member_index WHERE stronghold_id = ?").bind("medium5"),
      env.DB.prepare("DELETE FROM stronghold_slug_index WHERE stronghold_id = ?").bind("medium5"),
      env.DB.prepare("DELETE FROM stronghold_directory_index WHERE stronghold_id = ?").bind("medium5"),
    ]);
    await stronghold.purgeForStrongholdDeletion();
    env.FIXED_STRONGHOLD = undefined;
  });

  it("initializes and exposes only medium5", async () => {
    const configResponse = await apiRequest("/api/instance/config");
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({
      fixed_stronghold: { id: "medium5", name: "medium5", slug: "medium5" },
      logo_url: null,
      emotes_enabled: true,
      reactions_enabled: true,
    });

    const directoryResponse = await apiRequest("/api/directory");
    expect(directoryResponse.status).toBe(200);
    expect(await directoryResponse.json()).toMatchObject({
      strongholds: [{ id: "medium5", name: "medium5", slug: "medium5" }],
    });

    const resolveResponse = await apiRequest("/api/resolve/a/medium5");
    expect(resolveResponse.status).toBe(200);
    expect(await resolveResponse.json()).toEqual({ stronghold_id: "medium5" });

    const otherSlugResponse = await apiRequest("/api/resolve/a/other-place");
    expect(otherSlugResponse.status).toBe(404);

    const strongholdResponse = await apiRequest("/api/stronghold/medium5/config");
    expect(strongholdResponse.status).toBe(200);
    expect((await strongholdResponse.json()).name).toBe("medium5");
  });

  it("rejects creation, alternate strongholds, and destructive fixed-mode operations", async () => {
    const createResponse = await apiRequest("/api/strongholds", {
      method: "POST",
      body: JSON.stringify({ name: "other" }),
    });
    expect(createResponse.status).toBe(403);
    expect(await createResponse.json()).toEqual({ error: "STRONGHOLD_FIXED" });

    const otherStrongholdResponse = await apiRequest("/api/stronghold/other");
    expect(otherStrongholdResponse.status).toBe(404);

    const deleteResponse = await apiRequest("/api/stronghold/medium5", { method: "DELETE" });
    expect(deleteResponse.status).toBe(403);
    expect(await deleteResponse.json()).toEqual({ error: "STRONGHOLD_FIXED" });
  });

  it("enforces the deployment emote switch at the API boundary", async () => {
    env.ENABLE_EMOTES = "0";
    const response = await apiRequest("/api/emotes");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "FEATURE_DISABLED" });
    env.ENABLE_EMOTES = undefined;
  });
});
