import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomDO } from "../server/src/room-do";
import migration0026 from "../server/migrations/0026_archive_search.sql?raw";
import {
  apiRequest,
  connectRoom,
  ensureMigrated,
  itemCreateFrame,
  nextMessage,
  sessionToken,
} from "./helpers";

async function ensureArchiveSchema(): Promise<void> {
  await ensureMigrated();
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_backup'",
  ).first();
  if (table) return;
  for (const statement of migration0026
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((sql) => sql.trim())
    .filter(Boolean)) {
    if (statement.startsWith("ALTER TABLE archive_index ADD COLUMN")) {
      const column = statement.endsWith("content_sha256 TEXT")
        ? "content_sha256"
        : "item_count";
      const columns = await env.DB.prepare(
        "PRAGMA table_info(archive_index)",
      ).all<{ name: string }>();
      if (columns.results.some((entry) => entry.name === column)) continue;
    }
    await env.DB.prepare(statement).run();
  }
}

describe("M3 archive search contract", () => {
  it("archives cold items to a gzip R2 shard and keeps them in seq-paged history", async () => {
    await ensureArchiveSchema();
    const doKey = `archive-contract/ch/${crypto.randomUUID()}`;
    const { ws, stub } = await connectRoom(
      doKey,
      "@archiveowner:local",
      "owner",
    );
    ws.send(itemCreateFrame("archive-one", "archive searchable term"));
    expect((await nextMessage(ws)).type).toBe("ack");

    const archived = await (
      stub as unknown as { archiveNow(): Promise<number> }
    ).archiveNow();
    expect(archived).toBe(1);
    const rows = await env.DB.prepare(
      "SELECT seq_start, seq_end, r2_key FROM archive_index WHERE do_key = ?",
    )
      .bind(doKey)
      .all<{
        seq_start: number;
        seq_end: number;
        r2_key: string;
      }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.seq_start).toBe(1);
    expect(rows.results[0]!.seq_end).toBe(1);
    expect(rows.results[0]!.r2_key).toMatch(/\.ndjson\.gz$/);

    const history = await (
      stub as unknown as {
        getHistory(
          before: number | null,
          limit: number,
          actor: string | null,
        ): Promise<{ items: unknown[] }>;
      }
    ).getHistory(null, 50, null);
    expect(history.items).toEqual([
      expect.objectContaining({
        seq: 1,
        body: { text: "archive searchable term" },
      }),
    ]);
    ws.close();
  });

  it("keeps seq monotonic and dedupe mappings after archive deletion", async () => {
    await ensureArchiveSchema();
    const doKey = `archive-dedupe/ch/${crypto.randomUUID()}`;
    const { ws, stub } = await connectRoom(
      doKey,
      "@archiveowner:local",
      "owner",
    );
    ws.send(itemCreateFrame("same-client", "first body"));
    const created = await nextMessage(ws);
    await (stub as unknown as { archiveNow(): Promise<number> }).archiveNow();

    ws.send(itemCreateFrame("same-client", "must not duplicate"));
    const duplicate = await nextMessage(ws);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.seq).toBe(created.seq);

    ws.send(itemCreateFrame("next-client", "second body"));
    const second = await nextMessage(ws);
    expect(second.seq).toBe(2);
    ws.close();
  });

  it("fills history pages across deleted cold rows without losing the older-page cursor", async () => {
    await ensureArchiveSchema();
    const doKey = `archive-page-holes/ch/${crypto.randomUUID()}`;
    const actor = "@archivepager:local";
    const { ws, stub } = await connectRoom(doKey, actor, "owner");
    for (let seq = 1; seq <= 4; seq++) {
      ws.send(itemCreateFrame(`page-${seq}`, `page item ${seq}`));
      expect((await nextMessage(ws)).status).toBe("ok");
    }
    await (stub as unknown as { archiveNow(): Promise<number> }).archiveNow();
    for (const seq of [3, 4]) {
      expect(
        await (
          stub as unknown as {
            retractItem(
              actor: string,
              role: "owner",
              roomRef: string,
              seq: number,
            ): Promise<{ ok: boolean }>;
          }
        ).retractItem(actor, "owner", doKey, seq),
      ).toMatchObject({ ok: true });
    }

    const first = await (
      stub as unknown as {
        getHistory(
          before: number | null,
          limit: number,
          actor: string | null,
        ): Promise<{
          items: Array<{ seq: number }>;
          next_before: number | null;
          has_more: boolean;
        }>;
      }
    ).getHistory(5, 1, null);
    expect(first.items).toEqual([
      expect.objectContaining({ seq: 2, body: { text: "page item 2" } }),
    ]);
    expect(first.has_more).toBe(true);
    expect(first.next_before).toBe(2);

    const second = await (
      stub as unknown as {
        getHistory(
          before: number | null,
          limit: number,
          actor: string | null,
        ): Promise<{
          items: Array<{ seq: number }>;
          next_before: number | null;
          has_more: boolean;
        }>;
      }
    ).getHistory(first.next_before, 1, null);
    expect(second.items.map((item) => item.seq)).toEqual([1]);
    expect(second.has_more).toBe(false);
    ws.close();
  });

  it("keeps edit and tombstone overlays authoritative after an item is archived", async () => {
    await ensureArchiveSchema();
    const doKey = `archive-edit/ch/${crypto.randomUUID()}`;
    const actor = "@archiveeditor:local";
    const { ws, stub } = await connectRoom(doKey, actor, "owner");
    ws.send(itemCreateFrame("before-edit", "old searchable word"));
    expect((await nextMessage(ws)).status).toBe("ok");
    await (stub as unknown as { archiveNow(): Promise<number> }).archiveNow();

    const edited = await (
      stub as unknown as {
        editItem(
          actor: string,
          roomRef: string,
          seq: number,
          body: unknown,
        ): Promise<{ ok: boolean }>;
      }
    ).editItem(actor, doKey, 1, { text: "replacement phrase" });
    expect(edited.ok).toBe(true);
    await (
      stub as unknown as { reconcileArchiveSearch(): Promise<void> }
    ).reconcileArchiveSearch();
    const afterEdit = await (
      stub as unknown as {
        getHistory(
          before: number | null,
          limit: number,
          actor: string | null,
        ): Promise<{ items: Array<{ seq: number; body: { text: string } }> }>;
      }
    ).getHistory(null, 20, null);
    expect(afterEdit.items[0]).toMatchObject({
      seq: 1,
      body: { text: "replacement phrase" },
    });
    const updatedSearch = await env.DB.prepare(
      "SELECT seq FROM archive_search WHERE archive_search MATCH ? AND do_key = ?",
    )
      .bind('"replacement"*', doKey)
      .all<{ seq: string }>();
    expect(updatedSearch.results).toEqual([{ seq: "1" }]);

    const deleted = await (
      stub as unknown as {
        retractItem(
          actor: string,
          role: "owner",
          roomRef: string,
          seq: number,
        ): Promise<{ ok: boolean }>;
      }
    ).retractItem(actor, "owner", doKey, 1);
    expect(deleted.ok).toBe(true);
    await (
      stub as unknown as { reconcileArchiveSearch(): Promise<void> }
    ).reconcileArchiveSearch();
    expect(
      await (
        stub as unknown as {
          getHistory(
            before: number | null,
            limit: number,
            actor: string | null,
          ): Promise<{ items: unknown[] }>;
        }
      ).getHistory(null, 20, null),
    ).toMatchObject({ items: [] });
    const deletedSearch = await env.DB.prepare(
      "SELECT seq FROM archive_search WHERE archive_search MATCH ? AND do_key = ?",
    )
      .bind('"replacement"*', doKey)
      .all();
    expect(deletedSearch.results).toEqual([]);
    ws.close();
  });

  it("scopes FTS results to the requested room key", async () => {
    await ensureArchiveSchema();
    const firstRoom = `search-scope/ch/${crypto.randomUUID()}`;
    const secondRoom = `search-scope/ch/${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO archive_document (do_key, seq, text, actor, ts, kind, root_seq) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        firstRoom,
        "1",
        "shared phrase",
        "@alice:local",
        "1",
        "post",
        "1",
        secondRoom,
        "1",
        "shared phrase",
        "@bob:local",
        "1",
        "post",
        "1",
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO archive_search(archive_search) VALUES ('rebuild')",
    ).run();
    const result = await env.DB.prepare(
      "SELECT do_key, seq FROM archive_search WHERE archive_search MATCH ? AND do_key = ?",
    )
      .bind('"shared phrase"', firstRoom)
      .all<{ do_key: string; seq: string }>();
    expect(result.results).toEqual([{ do_key: firstRoom, seq: "1" }]);
  });

  it("searches archived text only after the stronghold visibility and room gate", async () => {
    await ensureArchiveSchema();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const strongholdId = `search${suffix}`;
    const owner = `@owner${suffix}:local`;
    const outsider = `@outsider${suffix}:local`;
    const doKey = `${strongholdId}/ch/general`;
    const stronghold = env.STRONGHOLD_DO.getByName(strongholdId);
    await stronghold.initConfig(
      strongholdId,
      "Private search",
      "private",
      owner,
    );
    await stronghold.createRoom(
      "general",
      "channel",
      "General",
      ["text"],
      false,
    );
    await env.DB.prepare(
      "INSERT INTO archive_document (do_key, seq, text, actor, ts, kind, root_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(doKey, "40", "private archive needle", owner, "123", "post", "40")
      .run();
    await env.DB.prepare(
      "INSERT INTO archive_search(archive_search) VALUES ('rebuild')",
    ).run();

    const ownerToken = await sessionToken(owner);
    const search = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/general/search?q=archive%20needle`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      },
    );
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({
      items: [
        expect.objectContaining({ seq: 40, text: "private archive needle" }),
      ],
    });

    const outsiderToken = await sessionToken(outsider);
    const denied = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/general/search?q=archive`,
      {
        headers: { Authorization: `Bearer ${outsiderToken}` },
      },
    );
    expect(denied.status).toBe(403);
  });

  it("finds CJK substrings in cold archives without opening another room", async () => {
    await ensureArchiveSchema();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const id = `cjk${suffix}`;
    const owner = `@cjk${suffix}:local`;
    const stronghold = env.STRONGHOLD_DO.getByName(id);
    await stronghold.initConfig(id, "Search", "private", owner);
    await stronghold.createRoom(
      "general",
      "channel",
      "General",
      ["text"],
      false,
    );
    await env.DB.prepare(
      "INSERT INTO archive_document(do_key,seq,text,actor,ts,kind,root_seq) VALUES (?, '31', ?, ?, '123', 'post', '31'), (?, '32', ?, ?, '123', 'post', '32')",
    )
      .bind(
        `${id}/ch/general`,
        "今天讨论跨实例的账号迁移流程",
        owner,
        `${id}/ch/hidden`,
        "账号迁移的私密内容",
        owner,
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO archive_search(archive_search) VALUES ('rebuild')",
    ).run();
    const token = await sessionToken(owner);
    const result = await apiRequest(
      `/api/stronghold/${id}/rooms/general/search?q=${encodeURIComponent("账号迁移")}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      items: [{ seq: 31, text: "今天讨论跨实例的账号迁移流程" }],
    });
  });

  it("exports a room snapshot and restores it only into its own empty room", async () => {
    await ensureArchiveSchema();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const strongholdId = `backup${suffix}`;
    const roomId = "general";
    const doKey = `${strongholdId}/ch/${roomId}`;
    const owner = `@owner${suffix}:local`;
    const token = await sessionToken(owner);
    const stronghold = env.STRONGHOLD_DO.getByName(strongholdId);
    await stronghold.initConfig(strongholdId, "Backup test", "private", owner);
    await stronghold.createRoom(roomId, "channel", "General", ["text"], false);

    const { ws, stub } = await connectRoom(doKey, owner, "owner");
    ws.send(itemCreateFrame("backup-client", "snapshot body"));
    expect((await nextMessage(ws)).status).toBe("ok");
    const exportResponse = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/${roomId}/backups`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(exportResponse.status).toBe(200);
    const backup = (await exportResponse.json()) as {
      backup_id: string;
      sha256: string;
      bytes: number;
    };
    expect(backup).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bytes: expect.any(Number),
    });

    const download = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/${roomId}/backups/${backup.backup_id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(download.status).toBe(200);
    const plain = await new Response(
      download.body!.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const snapshotRecords = plain
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            room_ref?: string;
            table?: string;
            row?: { body?: string };
          },
      );
    expect(snapshotRecords[0]).toMatchObject({
      type: "snapshot",
      room_ref: doKey,
    });
    const itemRecord = snapshotRecords.find(
      (record) => record.type === "row" && record.table === "item",
    );
    expect(JSON.parse(itemRecord?.row?.body ?? "{}")).toEqual({
      text: "snapshot body",
    });

    ws.close();
    await runInDurableObject(
      stub,
      (_instance: RoomDO, state: DurableObjectState) => {
        for (const table of [
          "item",
          "tombstone",
          "edit",
          "dedupe_local",
          "dedupe_fed",
          "subscription",
          "post_index",
          "reaction",
          "local_event",
          "federation_state",
          "signed_event_archive",
        ]) {
          state.storage.sql.exec(`DELETE FROM ${table}`);
        }
        state.storage.sql.exec(
          "UPDATE meta SET value = 1 WHERE key = 'next_seq'",
        );
      },
    );
    const restore = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/${roomId}/restore`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backup_id: backup.backup_id }),
      },
    );
    expect(restore.status).toBe(200);
    const reopened = await connectRoom(doKey, owner, "owner");
    const history = await (
      reopened.stub as unknown as {
        getHistory(
          before: number | null,
          limit: number,
          actor: string | null,
        ): Promise<{ items: Array<{ seq: number; body: { text: string } }> }>;
      }
    ).getHistory(null, 20, null);
    expect(history.items).toEqual([
      expect.objectContaining({ seq: 1, body: { text: "snapshot body" } }),
    ]);
    reopened.ws.close();

    const otherRoom = "other";
    await stronghold.createRoom(otherRoom, "channel", "Other", ["text"], false);
    const crossRoom = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/${otherRoom}/restore`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backup_id: backup.backup_id }),
      },
    );
    expect(crossRoom.status).toBe(404);

    const outsiderToken = await sessionToken(`@outsider${suffix}:local`);
    const outsiderDownload = await apiRequest(
      `/api/stronghold/${strongholdId}/rooms/${roomId}/backups/${backup.backup_id}`,
      {
        headers: { Authorization: `Bearer ${outsiderToken}` },
      },
    );
    expect(outsiderDownload.status).toBe(403);
  });
});
