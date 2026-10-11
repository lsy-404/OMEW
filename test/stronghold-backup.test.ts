import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import migration0029 from "../server/migrations/0029_stronghold_backups.sql?raw";
import { exportStrongholdSnapshot, restoreStrongholdSnapshot } from "../server/src/stronghold-backup";
import type { StrongholdDO } from "../server/src/stronghold-do";
import { ensureMigrated } from "./helpers";

async function ensureBackupSchema(): Promise<void> {
  await ensureMigrated();
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stronghold_backup'"
  ).first();
  if (table) return;
  for (const statement of migration0029.split(";").map((sql) => sql.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
}

async function compressSnapshot(lines: string[]): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return new Uint8Array(compressed);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSource(id: string, owner: string) {
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Governance source", "private", owner, "preserved description", "shield", "source-slug");
  await stub.createRoom("general", "channel", "General", ["text"], true, 3, "Restricted room");
  await stub.addMember("@banned:local", "member", 4, true);
  await stub.banMember("@banned:local", owner, Date.now() + 60_000);
  await stub.reportTip(`${id}/ch/general`, 81);
  return stub;
}

async function clearGovernanceRows(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance: StrongholdDO, state: DurableObjectState) => {
    const tables = new Set(state.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).toArray().map((row) => row.name));
    for (const table of ["tip", "ban", "member", "room", "config", "member_migration", "control_event"]) {
      if (tables.has(table)) state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}

describe("Stronghold governance snapshots", () => {
  it("round-trips governance rows and preserves owner, ban, room and tip state", async () => {
    await ensureBackupSchema();
    const id = `stronghold-backup-${crypto.randomUUID()}`;
    const owner = `@owner-${crypto.randomUUID()}:local`;
    const source = await createSource(id, owner);
    const backupId = crypto.randomUUID();
    const snapshot = await runInDurableObject(source, (_instance: StrongholdDO, state: DurableObjectState) =>
      exportStrongholdSnapshot(state, env, id, backupId));
    expect(snapshot).toMatchObject({ r2_key: expect.stringContaining(id), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) });
    await env.DB.prepare(
      "INSERT INTO stronghold_backup (id, stronghold_id, owner_actor, r2_key, created_at, sha256, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(backupId, id, owner, snapshot.r2_key, Date.now(), snapshot.sha256, snapshot.bytes).run();

    const target = env.STRONGHOLD_DO.getByName(id);
    await clearGovernanceRows(target);
    const restoredRows = await runInDurableObject(target, (_instance: StrongholdDO, state: DurableObjectState) =>
      restoreStrongholdSnapshot(state, env, id, backupId, snapshot.r2_key, snapshot.sha256));
    expect(restoredRows).toBeGreaterThan(0);
    expect(await target.getConfig()).toMatchObject({ id, owner_actor: owner, name: "Governance source", slug: "source-slug" });
    expect(await target.listRooms()).toEqual([expect.objectContaining({ res_id: "general", restricted: 1, description: "Restricted room" })]);
    expect(await target.getMember("@banned:local")).toMatchObject({ role: "member", deny: 4, restricted: 1, banned_at: expect.any(Number) });
    expect(await target.listBans()).toEqual([expect.objectContaining({ actor: "@banned:local", operator: owner, expires_at: expect.any(Number) })]);
    expect(await target.getTips()).toEqual([expect.objectContaining({ room_ref: `${id}/ch/general`, latest_seq: 81 })]);
    const metadata = await env.DB.prepare("SELECT stronghold_id, owner_actor, sha256, byte_length FROM stronghold_backup WHERE id = ?")
      .bind(backupId).first();
    expect(metadata).toEqual({ stronghold_id: id, owner_actor: owner, sha256: snapshot.sha256, byte_length: snapshot.bytes });
  });

  it("rejects restore into a non-empty target without replacing its governance", async () => {
    await ensureBackupSchema();
    const id = `stronghold-backup-busy-${crypto.randomUUID()}`;
    const owner = `@owner-${crypto.randomUUID()}:local`;
    const source = await createSource(id, owner);
    const backupId = crypto.randomUUID();
    const snapshot = await runInDurableObject(source, (_instance: StrongholdDO, state: DurableObjectState) =>
      exportStrongholdSnapshot(state, env, id, backupId));
    const target = env.STRONGHOLD_DO.getByName(id);
    await clearGovernanceRows(target);
    await target.initConfig(id, "Do not replace", "public", owner, undefined, undefined, "existing-slug");

    await expect(runInDurableObject(target, (_instance: StrongholdDO, state: DurableObjectState) =>
      restoreStrongholdSnapshot(state, env, id, backupId, snapshot.r2_key, snapshot.sha256)))
      .rejects.toThrow("stronghold restore target is not empty");
    expect(await target.getConfig()).toMatchObject({ name: "Do not replace", slug: "existing-slug" });
    expect(await target.listRooms()).toEqual([]);
  });

  it("rejects a snapshot with an untrusted table name before executing table SQL", async () => {
    await ensureBackupSchema();
    const id = `stronghold-backup-invalid-${crypto.randomUUID()}`;
    const backupId = crypto.randomUUID();
    const key = `backups/strongholds/${encodeURIComponent(id)}/${backupId}.ndjson.gz`;
    const compressed = await compressSnapshot([JSON.stringify({
      type: "snapshot", schema: 1, stronghold_id: id,
      tables: ["config", "room", "member", "ban", "tip", "config; DROP TABLE member"], columns: {},
    })]);
    await env.MEDIA.put(key, compressed);
    const target = env.STRONGHOLD_DO.getByName(id);
    expect(await target.getConfig()).toBeNull();
    const checksum = await sha256(compressed);
    await expect(runInDurableObject(target, (_instance: StrongholdDO, state: DurableObjectState) =>
      restoreStrongholdSnapshot(state, env, id, backupId, key, checksum)))
      .rejects.toThrow("invalid stronghold snapshot header");
    expect(await target.getConfig()).toBeNull();
  });
});
