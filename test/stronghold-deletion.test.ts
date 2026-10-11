import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RoomDO } from "../server/src/room-do";
import migration0026 from "../server/migrations/0026_archive_search.sql?raw";
import { apiRequest, ensureMigrated, sessionToken } from "./helpers";

let sequence = 0;

async function createStronghold(owner: string, idOverride?: string): Promise<{ id: string; roomRef: string }> {
  const id = idOverride ?? `delete${Date.now()}${sequence++}`;
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Delete me", "public", owner, undefined, undefined, `delete-${sequence}`);
  await stub.createRoom("active", "channel", "Active", ["text"], false);
  await stub.createRoom("archived", "section", "Archived", ["text"], false);
  await stub.deleteRoom("archived");
  return { id, roomRef: `${id}/ch/active` };
}

beforeAll(async () => {
  await ensureMigrated();
  const migrated = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_backup'").first();
  if (!migrated) {
    for (const statement of migration0026.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((sql) => sql.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
  }
});

describe("DELETE /api/stronghold/:id", () => {
  it("lets the recorded stronghold owner delete and rejects members and server admins", async () => {
    const owner = "@deleteowner:local";
    const { id } = await createStronghold(owner);
    const member = "@deletemember:local";
    await env.STRONGHOLD_DO.getByName(id).addMember(member, "member");

    const memberResponse = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await sessionToken(member)}` },
    });
    expect(memberResponse.status).toBe(403);

    const serverAdminResponse = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await sessionToken("@instanceadmin:local", "admin")}` },
    });
    expect(serverAdminResponse.status).toBe(403);

    const ownerResponse = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await sessionToken(owner)}` },
    });
    expect(ownerResponse.status).toBe(204);
  });

  it("lets the server owner forcibly dissolve another owner's stronghold without membership", async () => {
    const { id } = await createStronghold("@forceowner:local");
    const response = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await sessionToken("@instanceowner:local", "owner")}` },
    });

    expect(response.status).toBe(204);
    expect(await env.STRONGHOLD_DO.getByName(id).getConfig()).toBeNull();
  });

  it("purges active and archived room DOs plus stronghold indexes, while leaving user media untouched", async () => {
    const owner = "@deletecleanup:local";
    const { id, roomRef } = await createStronghold(owner, `delete_${Date.now()}${sequence++}`);
    const archivedRef = `${id}/sec/archived`;
    const foreignArchiveRef = `${id.replace("_", "x")}/ch/foreign`;
    const backupKey = `backups/${encodeURIComponent(roomRef)}/${crypto.randomUUID()}.ndjson.gz`;
    const member = "@deleteguest:remote.example";
    await env.STRONGHOLD_DO.getByName(id).addMember(member, "member");
    await env.DB.prepare(
      "INSERT INTO guest_identity (actor, registered_origin, first_seen_at, last_assertion_at) VALUES (?, ?, ?, ?)"
    ).bind(member, "remote.example", Date.now(), Date.now()).run();
    await env.MEDIA.put("archive/keep-index-test", new Uint8Array([1]));
    await env.MEDIA.put("archive/foreign-index-test", new Uint8Array([2]));
    await env.MEDIA.put("archive/shared-index-test", new Uint8Array([3]));
    await env.MEDIA.put(backupKey, new Uint8Array([4]));
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)").bind(`cleanup-${sequence}`, id),
      env.DB.prepare("INSERT INTO guest_member_state (actor, stronghold_id) VALUES (?, ?)").bind(member, id),
      env.DB.prepare("INSERT INTO archive_index (do_key, seq_start, seq_end, r2_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(roomRef, 1, 3, "archive/keep-index-test", Date.now()),
      env.DB.prepare("INSERT INTO archive_index (do_key, seq_start, seq_end, r2_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(foreignArchiveRef, 1, 3, "archive/foreign-index-test", Date.now()),
      env.DB.prepare("INSERT INTO archive_index (do_key, seq_start, seq_end, r2_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(roomRef, 4, 6, "archive/shared-index-test", Date.now()),
      env.DB.prepare("INSERT INTO archive_index (do_key, seq_start, seq_end, r2_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(foreignArchiveRef, 4, 6, "archive/shared-index-test", Date.now()),
      env.DB.prepare("INSERT INTO media (id, hash, owner_actor, size, mime, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(`media-${sequence}`, "hash", owner, 10, "image/webp", "media/keep-test", Date.now()),
      env.DB.prepare("INSERT INTO room_backup (id, do_key, owner_actor, r2_key, created_at, sha256, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), roomRef, owner, backupKey, Date.now(), "digest", 1),
    ]);

    const response = await apiRequest(`/api/stronghold/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await sessionToken(owner)}` },
    });
    expect(response.status).toBe(204);
    expect(await env.STRONGHOLD_DO.getByName(id).getConfig()).toBeNull();

    for (const ref of [roomRef, archivedRef]) {
      const room = env.ROOM_DO.getByName(ref);
      await runInDurableObject(room, async (_instance: RoomDO, state: DurableObjectState) => {
        const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
        expect(tables).toEqual([]);
      });
    }

    expect(await env.DB.prepare("SELECT * FROM stronghold_member_index WHERE stronghold_id = ?").bind(id).all()).toEqual({ results: [], success: true, meta: expect.any(Object) });
    expect(await env.DB.prepare("SELECT * FROM stronghold_slug_index WHERE stronghold_id = ?").bind(id).all()).toEqual({ results: [], success: true, meta: expect.any(Object) });
    expect(await env.DB.prepare("SELECT * FROM stronghold_directory_index WHERE stronghold_id = ?").bind(id).all()).toEqual({ results: [], success: true, meta: expect.any(Object) });
    expect(await env.DB.prepare("SELECT * FROM guest_member_state WHERE stronghold_id = ?").bind(id).all()).toEqual({ results: [], success: true, meta: expect.any(Object) });
    expect(await env.DB.prepare("SELECT * FROM archive_index WHERE do_key = ? OR instr(do_key, ?) = 1").bind(id, `${id}/`).all()).toEqual({ results: [], success: true, meta: expect.any(Object) });
    expect(await env.DB.prepare("SELECT do_key FROM archive_index WHERE do_key = ?").bind(foreignArchiveRef).first()).toEqual({ do_key: foreignArchiveRef });
    expect(await env.MEDIA.get("archive/keep-index-test")).toBeNull();
    expect(await env.MEDIA.get("archive/foreign-index-test")).not.toBeNull();
    expect(await env.MEDIA.get("archive/shared-index-test")).not.toBeNull();
    expect(await env.MEDIA.get(backupKey)).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM room_backup WHERE do_key = ?").bind(roomRef).all()).toMatchObject({ results: [] });
    expect(await env.DB.prepare("SELECT id FROM media WHERE id = ?").bind(`media-${sequence}`).first()).toEqual({ id: `media-${sequence}` });
  });

  it("does not permit deleted strongholds to be revived with a new room", async () => {
    const owner = "@deletenorevive:local";
    const { id } = await createStronghold(owner);
    const token = await sessionToken(owner);
    const deleted = await apiRequest(`/api/stronghold/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect(deleted.status).toBe(204);

    const modern = await apiRequest(`/api/stronghold/${id}/rooms`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Nope", type: "channel" }),
    });
    expect(modern.status).toBe(404);
    const legacy = await apiRequest(`/stronghold/${id}/rooms`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ res_id: "nope", name: "Nope" }),
    });
    expect(legacy.status).toBe(404);

    const stalePaths = [
      `/stronghold/${id}`,
      `/api/stronghold/${id}/config`,
      `/api/stronghold/${id}/rooms`,
      `/stronghold/${id}/rooms/nope/history`,
      `/stronghold/${id}/rooms/nope/token`,
      `/stronghold/${id}/tips-token`,
    ];
    for (const path of stalePaths) {
      const response = await apiRequest(path, { method: path.endsWith("token") ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(404);
    }
  });

  it("does not retain the retired client-specified creation endpoint", async () => {
    const response = await apiRequest("/stronghold", { method: "POST", body: JSON.stringify({ id: "revive-me", name: "No" }) });
    expect(response.status).toBe(404);
  });
});
