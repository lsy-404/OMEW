import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiRequest, connectRoom, ensureMigrated, itemCreateFrame, loginAs, nextMessage, registerUser, sessionToken } from "./helpers";

// m0-protocol §7.10: server-level role tier. Registration bootstrap (first user
// -> owner) is covered in user-system.test.ts; this file covers the owner-only
// appointment/listing endpoints (PATCH/GET /api/admin/users) and the
// server_owner/server_admin permission-gate overlay onto stronghold roles -
// owner-equivalent everywhere except ownership transfer.

const OWNERSHIP = { ownership_pubkey: "test-pubkey", ownership_ciphertext: "test-ciphertext-blob" };
let userCounter = 0;

async function freshUser(prefix = "role"): Promise<{ actor: string; username: string; token: string }> {
  userCounter += 1;
  const username = `${prefix}${userCounter}`;
  const { status, json } = await registerUser({ username, password: "password123", ...OWNERSHIP });
  expect(status).toBe(200);
  return { actor: `@${username}:local`, username, token: json.token as string };
}

// Promotes via direct D1 write then re-logs-in - server_role rides in the
// session token claim, so a token minted before the promotion wouldn't reflect
// it (see helpers.loginAs).
async function makeOwner(): Promise<{ actor: string; username: string; token: string }> {
  const user = await freshUser("owner");
  await env.DB.prepare("UPDATE users SET server_role = 'owner' WHERE localpart = ?").bind(user.username).run();
  return { ...user, token: await loginAs(user.username) };
}

async function makeAdmin(): Promise<{ actor: string; username: string; token: string }> {
  const user = await freshUser("admin");
  await env.DB.prepare("UPDATE users SET server_role = 'admin' WHERE localpart = ?").bind(user.username).run();
  return { ...user, token: await loginAs(user.username) };
}

beforeAll(async () => {
  await ensureMigrated();
});

describe("GET /api/admin/users (server_owner/server_admin)", () => {
  it("lists the visible username alongside the stable localpart and role", async () => {
    const owner = await makeOwner();
    const listed = await freshUser("listuser");

    const res = await apiRequest("/api/admin/users", { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ localpart: string; username: string; server_role: string; created_at: number }>;
      next_cursor: string | null;
    };
    const entry = body.users.find((u) => u.localpart === listed.username);
    expect(entry).toMatchObject({ localpart: listed.username, username: listed.username, server_role: "user" });
    expect(typeof entry?.created_at).toBe("number");
  });

  it("lets a server_admin list users so existing server groups can be assigned", async () => {
    const admin = await makeAdmin();
    const target = await freshUser("groupmember");
    const res = await apiRequest("/api/admin/users", { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ localpart: string }> };
    expect(body.users.map((user) => user.localpart)).toContain(target.username);

    const groupRes = await apiRequest("/api/admin/server-groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ name: "Listed users" }),
    });
    expect(groupRes.status).toBe(201);
    const group = (await groupRes.json()) as { id: string };
    const assign = await apiRequest(`/api/admin/server-groups/${group.id}/members/${target.username}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(assign.status).toBe(204);

    const members = await apiRequest(`/api/admin/server-groups/${group.id}/members`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(await members.json()).toEqual({ localparts: [target.username] });
  });

  it("rejects a plain user", async () => {
    const user = await freshUser();
    const res = await apiRequest("/api/admin/users", { headers: { Authorization: `Bearer ${user.token}` } });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/me/strongholds server-admin discovery", () => {
  it("shows an unjoined server admin every indexed stronghold and its rooms, but not an unjoined user", async () => {
    const owner = await freshUser("discoveryowner");
    const admin = await makeAdmin();
    const ordinary = await freshUser("discoveryuser");
    const created = await apiRequest("/api/strongholds", {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "Admin Discovery" }),
    });
    expect(created.status).toBe(201);
    const stronghold = (await created.json()) as { id: string };
    await env.DB.prepare("INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)")
      .bind(`stale-discovery-${Date.now()}`, `deleted-discovery-${Date.now()}`)
      .run();

    const adminList = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(adminList.status).toBe(200);
    const adminNodes = (await adminList.json()) as Array<{ id: string; rooms: Array<{ id: string }> }>;
    expect(adminNodes.find((node) => node.id === stronghold.id)?.rooms.map((room) => room.id)).toEqual(
      expect.arrayContaining(["lobby", "posts"]),
    );
    expect(adminNodes.some((node) => node.id.startsWith("deleted-discovery-"))).toBe(false);

    const ordinaryList = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${ordinary.token}` } });
    expect(ordinaryList.status).toBe(200);
    const ordinaryNodes = (await ordinaryList.json()) as Array<{ id: string }>;
    expect(ordinaryNodes.some((node) => node.id === stronghold.id)).toBe(false);
  });
});

describe("PATCH /api/admin/users/:localpart (server_owner only)", () => {
  it("promotes a user to admin and demotes back to user", async () => {
    const owner = await makeOwner();
    const target = await freshUser("target");

    const promote = await apiRequest(`/api/admin/users/${target.username}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ server_role: "admin" }),
    });
    expect(promote.status).toBe(200);
    expect(await promote.json()).toEqual({ localpart: target.username, server_role: "admin" });
    const row = await env.DB.prepare("SELECT server_role FROM users WHERE localpart = ?")
      .bind(target.username)
      .first<{ server_role: string }>();
    expect(row?.server_role).toBe("admin");

    const promotedToken = await loginAs(target.username);
    const beforeDemotion = await apiRequest("/api/admin/invite-codes", {
      headers: { Authorization: `Bearer ${promotedToken}` },
    });
    expect(beforeDemotion.status).toBe(200);

    const demote = await apiRequest(`/api/admin/users/${target.username}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ server_role: "user" }),
    });
    expect(demote.status).toBe(200);
    expect(await demote.json()).toEqual({ localpart: target.username, server_role: "user" });

    const afterDemotion = await apiRequest("/api/admin/invite-codes", {
      headers: { Authorization: `Bearer ${promotedToken}` },
    });
    expect(afterDemotion.status).toBe(403);
    expect(await afterDemotion.json()).toEqual({ error: "ADMIN_REQUIRED" });
  });

  it("cannot promote to owner - 400 ROLE_INVALID", async () => {
    const owner = await makeOwner();
    const target = await freshUser("target2");
    const res = await apiRequest(`/api/admin/users/${target.username}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ server_role: "owner" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ROLE_INVALID" });
  });

  it("cannot modify its own row - 400 ROLE_INVALID", async () => {
    const owner = await makeOwner();
    const res = await apiRequest(`/api/admin/users/${owner.username}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ server_role: "admin" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ROLE_INVALID" });
  });

  it("rejects a server_admin caller - owner-only, not admin", async () => {
    const admin = await makeAdmin();
    const target = await freshUser("target3");
    const res = await apiRequest(`/api/admin/users/${target.username}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ server_role: "admin" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown localpart", async () => {
    const owner = await makeOwner();
    const res = await apiRequest("/api/admin/users/does-not-exist-at-all", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ server_role: "admin" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("is_admin compat field", () => {
  it("is true for server_role owner and admin, false for user", async () => {
    const owner = await makeOwner();
    const admin = await makeAdmin();
    const user = await freshUser();

    for (const [account, expected] of [
      [owner, { server_role: "owner", is_admin: true }],
      [admin, { server_role: "admin", is_admin: true }],
      [user, { server_role: "user", is_admin: false }],
    ] as const) {
      const res = await apiRequest("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: account.username, password: "password123" }),
      });
      const body = (await res.json()) as { user: Record<string, unknown> };
      expect(body.user).toMatchObject(expected);
    }
  });
});

describe("server_owner/server_admin permission-gate overlay in a stronghold they never joined (§7.10)", () => {
  async function freshStrongholdWithLobby(ownerActor: string): Promise<string> {
    const id = `overlay${Date.now()}${userCounter++}`;
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.initConfig(id, "Overlay Test Stronghold", "public", ownerActor);
    await stub.createRoom("lobby", "channel", "Lobby", ["text"], false);
    return id;
  }

  it("server_admin manages members, rooms, and every base setting through the owner overlay, but transfer/delete stay 403", async () => {
    const realOwner = "@ovlowner1:local";
    const member = "@ovlmember1:local";
    const admin = "@ovladmin1:local"; // never joins this stronghold
    const id = await freshStrongholdWithLobby(realOwner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(member, "member");
    const adminToken = await sessionToken(admin, "admin");

    // Every base-setting field, including owner-only visibility, succeeds despite
    // no membership row at all.
    const patchRes = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: "Admin configured",
        description: "moderated by server admin",
        visibility: "private",
        avatar: "/media/admin-avatar",
        cover: "/media/admin-cover",
        allow_message_edit: false,
        allow_message_retract: false,
        edit_window_secs: 60,
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    expect(patched.name).toBe("Admin configured");
    expect(patched.visibility).toBe("private");
    expect(patched.description).toBe("moderated by server admin");
    expect(patched.avatar).toBe("/media/admin-avatar");
    expect(patched.cover).toBe("/media/admin-cover");
    expect(patched.allow_message_edit).toBe(false);
    expect(patched.allow_message_retract).toBe(false);
    expect(patched.edit_window_secs).toBe(60);

    // Owner-equivalent management includes member deny and topic/topic-group
    // (channel/section) CRUD.
    const denyRes = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(member)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ deny: 1 }),
    });
    expect(denyRes.status).toBe(200);
    expect((await denyRes.json()) as Record<string, unknown>).toMatchObject({ actor: member, deny: 1 });

    const topic = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Admin topic", type: "channel" }),
    });
    expect(topic.status).toBe(201);
    const topicRoom = (await topic.json()) as { id: string; type: string };
    expect(topicRoom.type).toBe("channel");

    const topicGroup = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Admin topic group", type: "section" }),
    });
    expect(topicGroup.status).toBe(201);
    const topicGroupRoom = (await topicGroup.json()) as { id: string; type: string };
    expect(topicGroupRoom.type).toBe("section");
    const spareTopicGroup = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Spare topic group", type: "section" }),
    });
    expect(spareTopicGroup.status).toBe(201);
    const rooms = await apiRequest(`/api/stronghold/${id}/rooms`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(rooms.status).toBe(200);
    expect(((await rooms.json()) as Array<{ id: string }>).map((room) => room.id)).toEqual(expect.arrayContaining([topicRoom.id, topicGroupRoom.id]));

    const renameTopic = await apiRequest(`/api/stronghold/${id}/rooms/${topicRoom.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Renamed topic", description: "managed by admin" }),
    });
    expect(renameTopic.status).toBe(200);
    expect((await renameTopic.json()) as Record<string, unknown>).toMatchObject({ name: "Renamed topic", description: "managed by admin" });
    const renameTopicGroup = await apiRequest(`/api/stronghold/${id}/rooms/${topicGroupRoom.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Renamed topic group", description: "managed group" }),
    });
    expect(renameTopicGroup.status).toBe(200);
    expect((await renameTopicGroup.json()) as Record<string, unknown>).toMatchObject({ name: "Renamed topic group", description: "managed group" });
    expect((await apiRequest(`/api/stronghold/${id}/rooms/${topicRoom.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` },
    })).status).toBe(204);
    expect((await apiRequest(`/api/stronghold/${id}/rooms/${topicGroupRoom.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` },
    })).status).toBe(204);

    // moderate (retract) another member's message.
    const { ws } = await connectRoom(`${id}/ch/lobby`, member, "member");
    ws.send(itemCreateFrame("c1", "hello from member"));
    const ack = (await nextMessage(ws)) as { seq: number };
    ws.close();

    const delRes = await apiRequest(`/api/stronghold/${id}/rooms/lobby/items/${ack.seq}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);

    // the one exception: ownership transfer needs the real owner or server_owner.
    const transferRes = await apiRequest(`/api/stronghold/${id}/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ to: member }),
    });
    expect(transferRes.status).toBe(403);
    expect(await transferRes.json()).toEqual({ error: "FORBIDDEN" });

    const deleteRes = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deleteRes.status).toBe(403);
    expect(await deleteRes.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("server_owner (also never a member) can transfer ownership away from the real owner", async () => {
    const realOwner = "@ovlowner2:local";
    const member = "@ovlmember2:local";
    const serverOwner = "@ovlserverowner1:local";
    const id = await freshStrongholdWithLobby(realOwner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(member, "member");
    const ownerToken = await sessionToken(serverOwner, "owner");

    const transferRes = await apiRequest(`/api/stronghold/${id}/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ to: member }),
    });
    expect(transferRes.status).toBe(200);
    const transferred = (await transferRes.json()) as Record<string, unknown>;
    expect(transferred.owner_actor).toBe(member);
  });

  it("a plain user with no membership and no server role stays FORBIDDEN (overlay doesn't leak)", async () => {
    const realOwner = "@ovlowner3:local";
    const outsider = "@ovloutsider1:local";
    const id = await freshStrongholdWithLobby(realOwner);
    const outsiderToken = await sessionToken(outsider, "user");

    const patchRes = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${outsiderToken}` },
      body: JSON.stringify({ description: "should not work" }),
    });
    expect(patchRes.status).toBe(403);
  });
});
