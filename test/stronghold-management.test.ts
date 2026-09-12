import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RoomDO } from "../server/src/room-do";
import { HOME_DOMAIN } from "../server/src/types";
import {
  apiRequest,
  connectRoom,
  ensureMigrated,
  itemCreateFrame,
  itemDeleteFrame,
  itemUpdateFrame,
  nextMessage,
  sessionToken,
} from "./helpers";

// Stronghold-level settings (allow_message_edit/allow_message_retract/
// edit_window_secs), member/ban/transfer management, and the RoomDO edit/retract
// gating those settings drive. Member/ban/transfer suites mint session tokens
// directly (bypassing /api/register - see helpers.sessionToken) since they only
// exercise StrongholdDO/api.ts authorization, not the D1-backed user system.

let strongholdSeq = 0;
async function freshStronghold(ownerActor: string, visibility: "public" | "private" = "public"): Promise<string> {
  const id = `mgmt${Date.now()}${strongholdSeq++}`;
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Test Stronghold", visibility, ownerActor);
  return id;
}

beforeAll(async () => {
  await ensureMigrated();
});

describe("GET/PATCH /api/stronghold/:id/config", () => {
  it("returns the full config row (including task-016 fields) to a member", async () => {
    const owner = "@cfgowner1:local";
    const id = await freshStronghold(owner);
    const token = await sessionToken(owner);

    const res = await apiRequest(`/api/stronghold/${id}/config`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id,
      visibility: "public",
      avatar: null,
      allow_message_edit: true,
      allow_message_retract: true,
      edit_window_secs: 300,
      owner_actor: owner,
    });
  });

  it("lets a non-member preview public config", async () => {
    const owner = "@cfgowner2:local";
    const id = await freshStronghold(owner);
    const outsider = await sessionToken("@outsider1:local");

    const res = await apiRequest(`/api/stronghold/${id}/config`, { headers: { Authorization: `Bearer ${outsider}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, visibility: "public" });
  });

  it("lets mod patch non-visibility fields but not visibility", async () => {
    const owner = "@cfgowner3:local";
    const mod = "@cfgmod3:local";
    const id = await freshStronghold(owner);
    await env.STRONGHOLD_DO.getByName(id).addMember(mod, "mod");
    const modToken = await sessionToken(mod);

    const visRes = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(visRes.status).toBe(403);
    expect(await visRes.json()).toEqual({ error: "FORBIDDEN" });

    const descRes = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ description: "mod wrote this", avatar: "/media/cropped-avatar", edit_window_secs: 60 }),
    });
    expect(descRes.status).toBe(200);
    const body = (await descRes.json()) as Record<string, unknown>;
    expect(body.description).toBe("mod wrote this");
    expect(body.avatar).toBe("/media/cropped-avatar");
    expect(body.edit_window_secs).toBe(60);
    expect(body.visibility).toBe("public"); // untouched
  });

  it("keeps legacy strongholds avatar-free until a manager sets one, then permits clearing it", async () => {
    const owner = "@cfgowneravatar:local";
    const id = await freshStronghold(owner);
    const token = await sessionToken(owner);

    const before = await apiRequest(`/api/stronghold/${id}/config`, { headers: { Authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);
    expect((await before.json() as Record<string, unknown>).avatar).toBeNull();

    const set = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatar: "/media/cropped-avatar" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json() as Record<string, unknown>).avatar).toBe("/media/cropped-avatar");

    const clear = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatar: null }),
    });
    expect(clear.status).toBe(200);
    expect((await clear.json() as Record<string, unknown>).avatar).toBeNull();
  });

  it("rejects malformed avatar values without changing config", async () => {
    const owner = "@cfgownerinvalidavatar:local";
    const id = await freshStronghold(owner);
    const token = await sessionToken(owner);
    const res = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatar: 123 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "CONFIG_INVALID" });
    expect((await env.STRONGHOLD_DO.getByName(id).getConfig())?.avatar).toBeNull();
  });

  it("lets owner change visibility", async () => {
    const owner = "@cfgowner4:local";
    const id = await freshStronghold(owner);
    const ownerToken = await sessionToken(owner);

    const res = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ visibility: "private", cover: "https://example.com/cover.png" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.visibility).toBe("private");
    expect(body.cover).toBe("https://example.com/cover.png");
  });
});

describe("member management: deny-on-mod", () => {
  it("rejects applying deny to a mod, even combined with a demotion in one request", async () => {
    const owner = "@denyowner1:local";
    const mod = "@denymod1:local";
    const id = await freshStronghold(owner);
    await env.STRONGHOLD_DO.getByName(id).addMember(mod, "mod");
    const ownerToken = await sessionToken(owner);

    const denyOnly = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(mod)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ deny: 1 }),
    });
    expect(denyOnly.status).toBe(400);
    expect(await denyOnly.json()).toEqual({ error: "DENY_ON_MOD" });

    const combined = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(mod)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ role: "member", deny: 1 }),
    });
    expect(combined.status).toBe(400);
    expect(await combined.json()).toEqual({ error: "DENY_ON_MOD" });
  });

  it("allows deny once the mod is demoted in a prior, separate request", async () => {
    const owner = "@denyowner2:local";
    const mod = "@denymod2:local";
    const id = await freshStronghold(owner);
    await env.STRONGHOLD_DO.getByName(id).addMember(mod, "mod");
    const ownerToken = await sessionToken(owner);

    const demote = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(mod)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ role: "member" }),
    });
    expect(demote.status).toBe(200);
    expect((await demote.json() as Record<string, unknown>).role).toBe("member");

    const deny = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(mod)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ deny: 1 }),
    });
    expect(deny.status).toBe(200);
    const body = (await deny.json()) as Record<string, unknown>;
    expect(body.role).toBe("member");
    expect(body.deny).toBe(1);
  });

  it("requires owner to appoint/dismiss a mod - a mod cannot promote another member", async () => {
    const owner = "@denyowner3:local";
    const mod = "@denymod3:local";
    const member = "@denymember3:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(mod, "mod");
    await stub.addMember(member, "member");
    const modToken = await sessionToken(mod);

    const res = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(member)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${modToken}` },
      body: JSON.stringify({ role: "mod" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN" });
  });
});

describe("GET /api/stronghold/:id/members tabs", () => {
  it("splits all/restricted/banned correctly", async () => {
    const owner = "@tabowner1:local";
    const restricted = "@tabrestricted1:local";
    const plain = "@tabplain1:local";
    const banned = "@tabbanned1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(restricted, "member", 1);
    await stub.addMember(plain, "member", 0);
    await stub.addMember(banned, "member", 0);
    await stub.banMember(banned, owner);
    const ownerToken = await sessionToken(owner);

    const all = await apiRequest(`/api/stronghold/${id}/members?tab=all`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const allActors = ((await all.json()) as { entries: Array<{ actor: string }> }).entries.map((e) => e.actor);
    expect(allActors).toContain(owner);
    expect(allActors).toContain(restricted);
    expect(allActors).toContain(plain);
    expect(allActors).not.toContain(banned);

    const restrictedRes = await apiRequest(`/api/stronghold/${id}/members?tab=restricted`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const restrictedActors = ((await restrictedRes.json()) as { entries: Array<{ actor: string }> }).entries.map((e) => e.actor);
    expect(restrictedActors).toEqual([restricted]);

    const bannedRes = await apiRequest(`/api/stronghold/${id}/members?tab=banned`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const bannedActors = ((await bannedRes.json()) as { entries: Array<{ actor: string }> }).entries.map((e) => e.actor);
    expect(bannedActors).toEqual([banned]);
  });
});

describe("DELETE /api/stronghold/:id/members/:actor (kick)", () => {
  it("owner/mod can kick a member, nobody can kick the owner, mod cannot kick mod", async () => {
    const owner = "@kickowner1:local";
    const modA = "@kickmoda1:local";
    const modB = "@kickmodb1:local";
    const member = "@kickmember1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(modA, "mod");
    await stub.addMember(modB, "mod");
    await stub.addMember(member, "member");
    const ownerToken = await sessionToken(owner);
    const modAToken = await sessionToken(modA);

    const kickOwner = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(owner)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(kickOwner.status).toBe(403);

    const modKicksMod = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(modB)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${modAToken}` },
    });
    expect(modKicksMod.status).toBe(403);

    const modKicksMember = await apiRequest(`/api/stronghold/${id}/members/${encodeURIComponent(member)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${modAToken}` },
    });
    expect(modKicksMember.status).toBe(204);
    expect(await stub.getMember(member)).toBeNull();
  });
});

describe("bans: audit fields + guardrails", () => {
  it("records operator + banned_at, lists them, and unban clears both", async () => {
    const owner = "@banowner1:local";
    const target = "@bantarget1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member");
    const ownerToken = await sessionToken(owner);

    const putRes = await apiRequest(`/api/stronghold/${id}/bans/${encodeURIComponent(target)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.actor).toBe(target);
    expect(putBody.operator).toBe(owner);
    expect(putBody.banned_at).toBeTypeOf("number");

    const listRes = await apiRequest(`/api/stronghold/${id}/bans`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const listed = (await listRes.json()) as { entries: Array<Record<string, unknown>> };
    const entry = listed.entries.find((e) => e.actor === target);
    expect(entry).toMatchObject({ actor: target, operator: owner });
    expect(entry!.banned_at).toBeTypeOf("number");

    const unbanRes = await apiRequest(`/api/stronghold/${id}/bans/${encodeURIComponent(target)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(unbanRes.status).toBe(204);
    const afterUnban = (await stub.getMember(target))!;
    expect(afterUnban.banned_at).toBeNull();
    const listAfter = await apiRequest(`/api/stronghold/${id}/bans`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const listedAfter = (await listAfter.json()) as { entries: Array<Record<string, unknown>> };
    expect(listedAfter.entries.find((e) => e.actor === target)).toBeUndefined();
  });

  it("a mod cannot ban the owner or another mod", async () => {
    const owner = "@banowner2:local";
    const modA = "@banmoda2:local";
    const modB = "@banmodb2:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(modA, "mod");
    await stub.addMember(modB, "mod");
    const modAToken = await sessionToken(modA);

    const banOwner = await apiRequest(`/api/stronghold/${id}/bans/${encodeURIComponent(owner)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${modAToken}` },
    });
    expect(banOwner.status).toBe(403);

    const banMod = await apiRequest(`/api/stronghold/${id}/bans/${encodeURIComponent(modB)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${modAToken}` },
    });
    expect(banMod.status).toBe(403);
  });
});

describe("POST /api/stronghold/:id/transfer", () => {
  it("is owner-only, requires an existing member, and demotes the old owner", async () => {
    const owner = "@xferowner1:local";
    const member = "@xfermember1:local";
    const outsider = "@xferoutsider1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(member, "member");
    const ownerToken = await sessionToken(owner);
    const memberToken = await sessionToken(member);

    const byMember = await apiRequest(`/api/stronghold/${id}/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ to: owner }),
    });
    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toEqual({ error: "FORBIDDEN" });

    const toOutsider = await apiRequest(`/api/stronghold/${id}/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ to: outsider }),
    });
    expect(toOutsider.status).toBe(400);
    expect(await toOutsider.json()).toEqual({ error: "TARGET_NOT_MEMBER" });

    const res = await apiRequest(`/api/stronghold/${id}/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ to: member }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.owner_actor).toBe(member);

    const oldOwnerRow = await stub.getMember(owner);
    const newOwnerRow = await stub.getMember(member);
    expect(oldOwnerRow?.role).toBe("member");
    expect(oldOwnerRow?.deny).toBe(0);
    expect(newOwnerRow?.role).toBe("owner");

    // the demoted former owner can no longer change visibility.
    const staleOwnerPatch = await apiRequest(`/api/stronghold/${id}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(staleOwnerPatch.status).toBe(403);
  });
});

describe("GET /api/users/:actor", () => {
  it("returns a local user's profile", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (localpart, display_name, status, created_at) VALUES (?, ?, 'active', ?)"
    )
      .bind("profileuser1", "Profile User", now)
      .run();
    const requesterToken = await sessionToken("@someoneelse1:local");

    const res = await apiRequest(`/api/users/${encodeURIComponent(`@profileuser1:${HOME_DOMAIN}`)}`, {
      headers: { Authorization: `Bearer ${requesterToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: `@profileuser1:${HOME_DOMAIN}`,
      username: "profileuser1",
      display_name: "Profile User",
      avatar: null,
      cover: null,
      bio: null,
      created_at: now,
      is_guest: false,
    });
  });

  it("returns a guest actor's profile with home_domain", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO guest_identity (actor, registered_origin, display_name, avatar, first_seen_at, last_assertion_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind("@remoteuser1:remote.example", "remote.example", "Remote User", "https://remote.example/a.png", now, now)
      .run();
    const requesterToken = await sessionToken("@someoneelse2:local");

    const res = await apiRequest("/api/users/@remoteuser1:remote.example", {
      headers: { Authorization: `Bearer ${requesterToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: "@remoteuser1:remote.example",
      display_name: "Remote User",
      avatar: "https://remote.example/a.png",
      cover: null,
      bio: null,
      created_at: now,
      is_guest: true,
      home_domain: "remote.example",
    });
  });

  it("404s for an unknown actor", async () => {
    const requesterToken = await sessionToken("@someoneelse3:local");
    const res = await apiRequest(`/api/users/${encodeURIComponent("@nobody-here:local")}`, {
      headers: { Authorization: `Bearer ${requesterToken}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });
});

// ---- RoomDO edit/retract gating -------------------------------------------------

async function backdateItem(roomRef: string, seq: number, ts: number): Promise<void> {
  const stub = env.ROOM_DO.getByName(roomRef);
  await runInDurableObject(stub, async (_instance: RoomDO, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE item SET ts = ? WHERE seq = ?", ts, seq);
  });
}

describe("RoomDO edit/retract: author self-service gating", () => {
  it("lets the author edit their own message within the window, broadcast as item.update", async () => {
    const id = await freshStronghold("@edowner1:local");
    const roomRef = `${id}/ch/general`;
    const { ws: author } = await connectRoom(roomRef, "@edauthor1:local", "member");
    const { ws: watcher } = await connectRoom(roomRef, "@edwatcher1:local", "member");

    author.send(itemCreateFrame("m1", "original"));
    const createAck = await nextMessage(author);
    await nextMessage(watcher); // batch for item.create

    author.send(itemUpdateFrame(createAck.seq as number, "edited"));
    const editAck = await nextMessage(author);
    expect(editAck).toMatchObject({ type: "ack", status: "ok", target_seq: createAck.seq });

    const batch = await nextMessage(watcher);
    const items = batch.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ type: "item.update", target_seq: createAck.seq, body: { text: "edited" } });

    author.close();
    watcher.close();
  });

  it("EDIT_DISABLED when allow_message_edit is off", async () => {
    const id = await freshStronghold("@edowner2:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ allow_message_edit: 0 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@edauthor2:local", "member");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    ws.send(itemUpdateFrame(createAck.seq as number, "nope"));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "EDIT_DISABLED" });

    ws.close();
  });

  it("RETRACT_DISABLED when allow_message_retract is off", async () => {
    const id = await freshStronghold("@edowner3:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ allow_message_retract: 0 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@edauthor3:local", "member");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    ws.send(itemDeleteFrame(createAck.seq as number));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "RETRACT_DISABLED" });

    ws.close();
  });

  it("WINDOW_EXPIRED once edit_window_secs has elapsed since the original message", async () => {
    const id = await freshStronghold("@edowner4:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ edit_window_secs: 60 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@edauthor4:local", "member");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    await backdateItem(roomRef, createAck.seq as number, Date.now() - 120_000);

    ws.send(itemUpdateFrame(createAck.seq as number, "too late"));
    const editErr = await nextMessage(ws);
    expect(editErr).toMatchObject({ type: "error", code: "WINDOW_EXPIRED" });

    ws.send(itemDeleteFrame(createAck.seq as number));
    const deleteErr = await nextMessage(ws);
    expect(deleteErr).toMatchObject({ type: "error", code: "WINDOW_EXPIRED" });

    ws.close();
  });

  it("edit_window_secs = 0 means no window limit", async () => {
    const id = await freshStronghold("@edowner5:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ edit_window_secs: 0 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@edauthor5:local", "member");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    await backdateItem(roomRef, createAck.seq as number, Date.now() - 10_000_000);

    ws.send(itemUpdateFrame(createAck.seq as number, "still fine"));
    const ack = await nextMessage(ws);
    expect(ack).toMatchObject({ type: "ack", status: "ok" });

    ws.close();
  });

  it("the owner editing their own message is still gated by the switch (self-service, not moderation)", async () => {
    const id = await freshStronghold("@edowner6:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ allow_message_retract: 0 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@edowner6:local", "owner");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    ws.send(itemDeleteFrame(createAck.seq as number));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "RETRACT_DISABLED" });

    ws.close();
  });
});

describe("RoomDO edit/retract: moderator override", () => {
  it("mod deletes a member's message bypassing a disabled switch and an expired window", async () => {
    const id = await freshStronghold("@modowner1:local");
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ allow_message_retract: 0, edit_window_secs: 1 });
    const roomRef = `${id}/ch/general`;
    const { ws: member } = await connectRoom(roomRef, "@modmember1:local", "member");
    const { ws: mod } = await connectRoom(roomRef, "@modmod1:local", "mod");

    member.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(member);
    await backdateItem(roomRef, createAck.seq as number, Date.now() - 60_000);

    mod.send(itemDeleteFrame(createAck.seq as number, "moderation"));
    const ack = await nextMessage(mod);
    expect(ack).toMatchObject({ type: "ack", status: "ok", target_seq: createAck.seq });

    const batch = await nextMessage(member);
    const items = batch.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ type: "item.delete", target_seq: createAck.seq, by_role: "mod" });

    member.close();
    mod.close();
  });

  it("mod cannot delete the owner's message", async () => {
    const id = await freshStronghold("@modowner2:local");
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember("@modmod2:local", "mod");
    const roomRef = `${id}/ch/general`;
    const { ws: owner } = await connectRoom(roomRef, "@modowner2:local", "owner");
    const { ws: mod } = await connectRoom(roomRef, "@modmod2:local", "mod");

    owner.send(itemCreateFrame("m1", "owner's message"));
    const createAck = await nextMessage(owner);

    mod.send(itemDeleteFrame(createAck.seq as number));
    const err = await nextMessage(mod);
    expect(err).toMatchObject({ type: "error", code: "OMEW_FORBIDDEN" });

    owner.close();
    mod.close();
  });

  it("owner can delete a mod's message as moderation", async () => {
    const id = await freshStronghold("@modowner3:local");
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember("@modmod3:local", "mod");
    const roomRef = `${id}/ch/general`;
    const { ws: mod } = await connectRoom(roomRef, "@modmod3:local", "mod");
    const { ws: owner } = await connectRoom(roomRef, "@modowner3:local", "owner");

    mod.send(itemCreateFrame("m1", "mod's message"));
    const createAck = await nextMessage(mod);

    owner.send(itemDeleteFrame(createAck.seq as number));
    const ack = await nextMessage(owner);
    expect(ack).toMatchObject({ type: "ack", status: "ok", target_seq: createAck.seq });

    mod.close();
    owner.close();
  });
});

describe("config push + query-back fallback", () => {
  it("proactively pushes a config change to every room StrongholdDO knows about (DO-to-DO)", async () => {
    const id = await freshStronghold("@pushowner1:local");
    const stub = env.STRONGHOLD_DO.getByName(id);
    // Room must be registered in StrongholdDO's own room table for it to be a push
    // target - the RoomDO connections used elsewhere in this file skip that registry
    // entirely (direct token mint), which is exactly the fallback case tested below.
    await stub.createRoom("general", "channel", "General", ["text"], false);
    const roomRef = `${id}/ch/general`;

    await stub.updateConfig({ allow_message_edit: 0, edit_window_secs: 42 });

    const roomStub = env.ROOM_DO.getByName(roomRef);
    const cached = await runInDurableObject(roomStub, async (_instance: RoomDO, state: DurableObjectState) => {
      const rows = state.storage.sql
        .exec("SELECT key, value FROM meta WHERE key IN ('allow_message_edit', 'edit_window_secs')")
        .toArray() as Array<{ key: string; value: number }>;
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    });
    expect(cached.allow_message_edit).toBe(0);
    expect(cached.edit_window_secs).toBe(42);
  });

  it("falls back to a query-back when a room never got a push (e.g. created after the last config change)", async () => {
    const id = await freshStronghold("@pushowner2:local");
    // Config changes before this room ever connects - and this test never calls
    // StrongholdDO.createRoom either, so pushEditConfigToRooms has no record of it.
    await env.STRONGHOLD_DO.getByName(id).updateConfig({ allow_message_edit: 0 });
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, "@pushowner2:local", "owner");

    ws.send(itemCreateFrame("m1", "hi"));
    const createAck = await nextMessage(ws);
    ws.send(itemUpdateFrame(createAck.seq as number, "blocked"));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "EDIT_DISABLED" });

    ws.close();
  });
});

// ---- HTTP edit/retract endpoints -------------------------------------------------

describe("HTTP edit/retract endpoints", () => {
  it("edits and retracts over HTTP, broadcasting to connected WS observers", async () => {
    const owner = "@httpowner1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.createRoom("general", "channel", "General", ["text"], false);
    const ownerToken = await sessionToken(owner);
    const roomRef = `${id}/ch/general`;

    const { ws: watcher } = await connectRoom(roomRef, "@httpwatcher1:local", "member");
    const { ws: author } = await connectRoom(roomRef, owner, "owner");
    author.send(itemCreateFrame("m1", "via ws"));
    const createAck = await nextMessage(author);
    await nextMessage(watcher); // item.create batch
    const seq = createAck.seq as number;

    const editRes = await apiRequest(`/api/stronghold/${id}/rooms/general/items/${seq}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ content: { text: "edited over http" } }),
    });
    expect(editRes.status).toBe(200);
    const editBatch = await nextMessage(watcher);
    const editItems = editBatch.items as Array<Record<string, unknown>>;
    expect(editItems[0]).toMatchObject({ type: "item.update", target_seq: seq, body: { text: "edited over http" } });

    const retractRes = await apiRequest(`/api/stronghold/${id}/rooms/general/items/${seq}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(retractRes.status).toBe(200);
    const deleteBatch = await nextMessage(watcher);
    const deleteItems = deleteBatch.items as Array<Record<string, unknown>>;
    expect(deleteItems[0]).toMatchObject({ type: "item.delete", target_seq: seq });

    watcher.close();
    author.close();
  });

  it("rejects a banned actor with FORBIDDEN before touching RoomDO", async () => {
    const owner = "@httpowner2:local";
    const banned = "@httpbanned2:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.createRoom("general", "channel", "General", ["text"], false);
    await stub.addMember(banned, "member");
    await stub.banMember(banned, owner);
    const bannedToken = await sessionToken(banned);

    const res = await apiRequest(`/api/stronghold/${id}/rooms/general/items/1`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bannedToken}` },
      body: JSON.stringify({ content: { text: "nope" } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "FORBIDDEN" });
  });
});

it("legacy :local member rows are lazily adopted under the configured domain", async () => {
  const id = `legacy${Date.now()}`;
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Legacy", "public", "@relic:local");
  const adopted = await stub.getMember("@relic:omew.test");
  expect(adopted).not.toBeNull();
  expect(adopted!.role).toBe("owner");
  const direct = await stub.getMember("@relic:omew.test");
  expect(direct!.actor).toBe("@relic:omew.test");
  expect(direct).toMatchObject({ role: "owner", deny: 0 });
});
