import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { apiRequest, connectRoom, ensureMigrated, loginAs, nextClose, registerUser, sessionToken } from "./helpers";

const OWNERSHIP = { ownership_pubkey: "test-pubkey", ownership_ciphertext: "test-ciphertext-blob" };
let sequence = 0;

async function user(prefix: string): Promise<{ username: string; actor: string; token: string }> {
  sequence += 1;
  const username = `${prefix}${sequence}`;
  const created = await registerUser({ username, password: "password123", ...OWNERSHIP });
  expect(created.status).toBe(200);
  return { username, actor: `@${username}:local`, token: created.json.token as string };
}

async function elevated(role: "owner" | "admin"): Promise<{ username: string; actor: string; token: string }> {
  const account = await user(role);
  await env.DB.prepare("UPDATE users SET server_role = ? WHERE localpart = ?").bind(role, account.username).run();
  return { ...account, token: await loginAs(account.username) };
}

beforeAll(async () => {
  await ensureMigrated();
});

describe("global account bans", () => {
  it("allows owner/admin to ban ordinary local users, blocks existing sessions and login, and lists the audit fields", async () => {
    const owner = await elevated("owner");
    const admin = await elevated("admin");
    const target = await user("target");
    const expiry = Date.now() + 60_000;

    const banned = await apiRequest(`/api/admin/bans/${encodeURIComponent(target.actor)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ expires_at: expiry }),
    });
    expect(banned.status).toBe(200);
    expect(await banned.json()).toMatchObject({ actor: target.actor, operator: admin.actor, expires_at: expiry });

    const session = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${target.token}` } });
    expect(session.status).toBe(401);
    const login = await apiRequest("/api/login", { method: "POST", body: JSON.stringify({ username: target.username, password: "password123" }) });
    expect(login.status).toBe(401);

    const listed = await apiRequest("/api/admin/bans", { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { entries: Array<Record<string, unknown>> }).entries).toContainEqual(
      expect.objectContaining({ actor: target.actor, username: target.username, operator: admin.actor, expires_at: expiry }),
    );

    const unbanned = await apiRequest(`/api/admin/bans/${encodeURIComponent(target.actor)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(unbanned.status).toBe(204);
    const restored = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${target.token}` } });
    expect(restored.status).toBe(200);
  });

  it("restores an expired timed ban lazily on the next session check", async () => {
    const owner = await elevated("owner");
    const target = await user("expired");
    await env.DB.prepare(
      "UPDATE users SET status = 'banned', banned_at = ?, banned_by = ?, banned_until = ? WHERE localpart = ?"
    ).bind(Date.now() - 10, owner.actor, Date.now() - 1, target.username).run();

    const restored = await apiRequest("/api/me/strongholds", { headers: { Authorization: `Bearer ${target.token}` } });
    expect(restored.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, banned_until FROM users WHERE localpart = ?").bind(target.username)
      .first<{ status: string; banned_until: number | null }>();
    expect(row).toEqual({ status: "active", banned_until: null });
  });

  it("protects the server owner; server admins cannot target admins, but owners can", async () => {
    const owner = await elevated("owner");
    const admin = await elevated("admin");
    const otherAdmin = await elevated("admin");

    const ownerTarget = await apiRequest(`/api/admin/bans/${encodeURIComponent(owner.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${admin.token}` }, body: "{}",
    });
    expect(ownerTarget.status).toBe(403);
    const peerTarget = await apiRequest(`/api/admin/bans/${encodeURIComponent(otherAdmin.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${admin.token}` }, body: "{}",
    });
    expect(peerTarget.status).toBe(403);
    const ownerBan = await apiRequest(`/api/admin/bans/${encodeURIComponent(otherAdmin.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${owner.token}` }, body: "{}",
    });
    expect(ownerBan.status).toBe(200);
  });

  it("closes a globally banned server admin's live room socket even without a membership index row", async () => {
    const owner = await elevated("owner");
    const admin = await elevated("admin");
    const created = await apiRequest("/api/strongholds", {
      method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ name: `Global revoke ${sequence}` }),
    });
    expect(created.status).toBe(201);
    const stronghold = await created.json() as { id: string };
    const connected = await connectRoom(`${stronghold.id}/ch/lobby`, admin.actor, "owner");
    const closing = nextClose(connected.ws);

    const banned = await apiRequest(`/api/admin/bans/${encodeURIComponent(admin.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${owner.token}` }, body: "{}",
    });
    expect(banned.status).toBe(200);
    expect(await closing).toEqual({ code: 1008, reason: "OMEW_SESSION_INVALID" });
  });

  it("rejects ordinary users from global endpoints while keeping timed stronghold bans scoped to their stronghold", async () => {
    const owner = await user("strongowner");
    const target = await user("strongtarget");
    const outsider = await user("outsider");
    const created = await apiRequest("/api/strongholds", {
      method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ name: `Scoped ban ${sequence}` }),
    });
    const stronghold = await created.json() as { id: string };
    const stub = env.STRONGHOLD_DO.getByName(stronghold.id);
    await stub.addMember(target.actor, "member");
    const expiry = Date.now() + 60_000;

    const global = await apiRequest(`/api/admin/bans/${encodeURIComponent(target.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${owner.token}` }, body: "{}",
    });
    expect(global.status).toBe(403);
    const local = await apiRequest(`/api/stronghold/${stronghold.id}/bans/${encodeURIComponent(target.actor)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ expires_at: expiry }),
    });
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ expires_at: expiry });
    const localList = await apiRequest(`/api/stronghold/${stronghold.id}/bans`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(await localList.json()).toMatchObject({ entries: [expect.objectContaining({ actor: target.actor, expires_at: expiry })] });
    const outsiderGlobal = await apiRequest("/api/admin/bans", { headers: { Authorization: `Bearer ${outsider.token}` } });
    expect(outsiderGlobal.status).toBe(403);
  });
});
