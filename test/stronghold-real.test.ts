import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiRequest, ensureMigrated, sessionToken } from "./helpers";

// Stronghold real-ification: POST /api/strongholds default rooms,
// POST /api/stronghold/:id/rooms, join/leave, and GET /api/me/strongholds.

beforeAll(async () => {
  await ensureMigrated();
});

describe("POST /api/strongholds", () => {
  it("creates the stronghold with the creator as owner and default lobby channel + posts section", async () => {
    const owner = "@mkstronghold1:local";
    const token = await sessionToken(owner);

    const res = await apiRequest("/api/strongholds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "My Stronghold", description: "a test stronghold" }),
    });
    expect(res.status).toBe(201);
    const config = (await res.json()) as Record<string, unknown>;
    expect(config).toMatchObject({ name: "My Stronghold", description: "a test stronghold", visibility: "public", owner_actor: owner });
    const id = config.id as string;

    const stub = env.STRONGHOLD_DO.getByName(id);
    const owner_member = await stub.getMember(owner);
    expect(owner_member?.role).toBe("owner");

    const rooms = await stub.listRooms();
    expect(rooms).toHaveLength(2);
    const lobby = rooms.find((r) => r.type === "channel");
    const posts = rooms.find((r) => r.type === "section");
    expect(lobby).toMatchObject({ res_id: "lobby", name: "大厅" });
    expect(posts).toMatchObject({ res_id: "posts", name: "帖子" });
  });

  it("rejects an unauthenticated request and a missing name", async () => {
    const noAuth = await apiRequest("/api/strongholds", { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(noAuth.status).toBe(401);

    const token = await sessionToken("@mkstronghold2:local");
    const noName = await apiRequest("/api/strongholds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ error: "MALFORMED" });
  });
});

describe("POST /api/stronghold/:id/rooms", () => {
  it("lets owner/mod create a room, rejects a plain member", async () => {
    const owner = "@mkroomowner1:local";
    const member = "@mkroommember1:local";
    const id = `mkroom${Date.now()}`;
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.initConfig(id, "Room Test", "public", owner);
    await stub.addMember(member, "member");
    const ownerToken = await sessionToken(owner);
    const memberToken = await sessionToken(member);

    const res = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "Announcements", type: "channel" }),
    });
    expect(res.status).toBe(201);
    const room = (await res.json()) as Record<string, unknown>;
    expect(room).toMatchObject({ name: "Announcements", type: "channel" });
    expect(room.id).toBeTypeOf("string");

    const forbidden = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ name: "Nope", type: "channel" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("lets a moderator manage both room types while preserving the final room of each type", async () => {
    const owner = "@roommanageowner:local";
    const moderator = "@roommanagemod:local";
    const member = "@roommanagemember:local";
    const id = `roommanage${Date.now()}`;
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.initConfig(id, "Room Management", "public", owner);
    await stub.addMember(moderator, "mod");
    await stub.addMember(member, "member");
    const moderatorToken = await sessionToken(moderator);
    const memberToken = await sessionToken(member);

    const create = async (name: string, type: "channel" | "section") => {
      const res = await apiRequest(`/api/stronghold/${id}/rooms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: JSON.stringify({ name, type }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; name: string; type: string; description: string | null };
    };

    const channel = await create("Chat", "channel");
    const secondChannel = await create("Updates", "channel");
    const section = await create("Ideas", "section");
    const secondSection = await create("Guides", "section");

    const patch = await apiRequest(`/api/stronghold/${id}/rooms/${channel.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${moderatorToken}` },
      body: JSON.stringify({ name: "Discussion", description: "Live chat", position: 3 }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ id: channel.id, name: "Discussion", description: "Live chat", type: "channel" });

    const listed = await apiRequest(`/api/stronghold/${id}/rooms`);
    expect(listed.status).toBe(200);
    const listedRooms = (await listed.json()) as Array<{ id: string; name: string; description: string | null }>;
    expect(listedRooms).toContainEqual(expect.objectContaining({ id: channel.id, name: "Discussion", description: "Live chat" }));

    const forbidden = await apiRequest(`/api/stronghold/${id}/rooms/${channel.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(forbidden.status).toBe(403);

    for (const room of [secondChannel, secondSection]) {
      const del = await apiRequest(`/api/stronghold/${id}/rooms/${room.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${moderatorToken}` },
      });
      expect(del.status).toBe(204);
    }

    for (const room of [channel, section]) {
      const del = await apiRequest(`/api/stronghold/${id}/rooms/${room.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${moderatorToken}` },
      });
      expect(del.status).toBe(409);
      expect(await del.json()).toEqual({ error: "LAST_ROOM_OF_TYPE" });
    }
  });
});

describe("POST /api/stronghold/:id/join", () => {
  it("joins a public stronghold directly and is idempotent on re-join", async () => {
    const owner = "@joinowner1:local";
    const joiner = "@joiner1:local";
    const id = `join${Date.now()}`;
    await env.STRONGHOLD_DO.getByName(id).initConfig(id, "Public SH", "public", owner);
    const joinerToken = await sessionToken(joiner);

    const first = await apiRequest(`/api/stronghold/${id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${joinerToken}` },
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ actor: joiner, role: "member" });

    const second = await apiRequest(`/api/stronghold/${id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${joinerToken}` },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toMatchObject({ actor: joiner, role: "member" });
  });

  it("holds a private stronghold application until an administrator approves it", async () => {
    const owner = "@joinowner2:local";
    const joiner = "@joiner2:local";
    const id = `joinpriv${Date.now()}`;
    await env.STRONGHOLD_DO.getByName(id).initConfig(id, "Private SH", "private", owner);
    const joinerToken = await sessionToken(joiner);

    const res = await apiRequest(`/api/stronghold/${id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${joinerToken}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({state:"pending"});
    const rooms=await apiRequest(`/api/stronghold/${id}/rooms`,{headers:{Authorization:`Bearer ${joinerToken}`}});
    expect(rooms.status).toBe(403);
    const ownerToken=await sessionToken(owner);
    const approval=await apiRequest(`/api/stronghold/${id}/join-requests/${encodeURIComponent(joiner)}`,{method:"PATCH",headers:{Authorization:`Bearer ${ownerToken}`},body:JSON.stringify({state:"approved"})});
    expect(approval.status).toBe(200);
    const allowed=await apiRequest(`/api/stronghold/${id}/rooms`,{headers:{Authorization:`Bearer ${joinerToken}`}});
    expect(allowed.status).toBe(200);
  });
});

describe("POST /api/stronghold/:id/leave", () => {
  it("blocks the owner from leaving directly, lets a member leave", async () => {
    const owner = "@leaveowner1:local";
    const member = "@leavemember1:local";
    const id = `leave${Date.now()}`;
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.initConfig(id, "Leave Test", "public", owner);
    await stub.addMember(member, "member");
    const ownerToken = await sessionToken(owner);
    const memberToken = await sessionToken(member);

    const ownerLeave = await apiRequest(`/api/stronghold/${id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerLeave.status).toBe(400);
    expect(await ownerLeave.json()).toEqual({ error: "OWNER_MUST_TRANSFER" });

    const memberLeave = await apiRequest(`/api/stronghold/${id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberLeave.status).toBe(204);
    expect(await stub.getMember(member)).toBeNull();
  });
});

describe("GET /api/me/strongholds", () => {
  it("lists strongholds the actor has joined, with their rooms", async () => {
    const actor = "@mystrongholds1:local";
    const other = "@mystrongholdsother1:local";
    const token = await sessionToken(actor);

    const created = await apiRequest("/api/strongholds", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Mine" }),
    });
    const config = (await created.json()) as Record<string, unknown>;

    // A stronghold the actor never joined MUST NOT show up.
    await env.STRONGHOLD_DO.getByName(`notmine${Date.now()}`).initConfig(`notmine${Date.now()}`, "Not Mine", "public", other);

    const res = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      id: string;
      name: string;
      rooms: Array<{ id: string; name: string; type: string; description: string | null }>;
    }>;
    const mine = list.find((s) => s.id === config.id);
    expect(mine).toBeTruthy();
    expect(mine!.name).toBe("Mine");
    expect(mine!.rooms).toContainEqual({ id: "lobby", name: "大厅", type: "channel", description: null, capabilities:["text","reactions"] });
    expect(mine!.rooms).toContainEqual({ id: "posts", name: "帖子", type: "section", description: null, capabilities:["text","reactions"] });
    expect(list.find((s) => s.name === "Not Mine")).toBeUndefined();
  });

  it("drops off the list once the actor leaves", async () => {
    const actor = "@mystrongholds2:local";
    const owner = "@mystrongholdsowner2:local";
    const id = `leavelist${Date.now()}`;
    await env.STRONGHOLD_DO.getByName(id).initConfig(id, "Leave List Test", "public", owner);
    const token = await sessionToken(actor);

    await apiRequest(`/api/stronghold/${id}/join`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const before = (await (await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{
      id: string;
    }>;
    expect(before.some((s) => s.id === id)).toBe(true);

    await apiRequest(`/api/stronghold/${id}/leave`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const after = (await (await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{
      id: string;
    }>;
    expect(after.some((s) => s.id === id)).toBe(false);
  });
});
