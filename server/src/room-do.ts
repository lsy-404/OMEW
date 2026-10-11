import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { verifyToken } from "./auth";
import { reportThreshold } from "./account-recovery";
import { socketActorIsActive } from "./socket-auth";
import { canAccessRestrictedRoom } from "./permissions";
import { newEvent, queueDelivery } from "./federation";
import {
  Envelope,
  JsonObject,
  ProtocolError,
  object,
  strictJson,
  uuidV7,
} from "./federation-codec";
import { getInstanceBranding } from "./config";
import { markdownPreview } from "./markdown-preview";
import {
  ARCHIVE_ALARM_MS,
  ARCHIVE_SHARD_ITEMS,
  HOT_AGE_MS,
  HOT_ITEM_LIMIT,
  archiveObjectKey,
  gzipJsonLines,
  putArchiveStream,
  readGzipJsonLines,
  readGzipRecordsUntil,
  searchableText,
  type ArchiveItem,
} from "./archive";
import {
  featurePaused,
  type EditConfigSnapshot,
  type FeatureRestrictionSnapshot,
  type MemberRevokePayload,
} from "./stronghold-do";
import {
  DENY_CHANNEL_SPEAK,
  DENY_SECTION_POST,
  DENY_SECTION_REPLY,
  instanceDomain,
  withRequestInstanceDomain,
  type Role,
  type RoomTokenClaims,
} from "./types";

// proposal S4.2: Channel and Section share this implementation; a channel is the
// degenerate case where every item has parent_seq IS NULL. Kind (ch|sec) is carried
// in the room-ref, not stored separately here - it only matters for the deny-bit
// rule below and is read off the WS token's `room` claim at handshake time.

const BATCH_WINDOW_MS = 80;
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;
const RESYNC_GAP_LIMIT = 500;
const POSTS_DEFAULT_LIMIT = 20;
const POSTS_MAX_LIMIT = 100;
const POST_TITLE_MAX = 64;
const PREVIEW_LEN = 80;

// proposal S4.5: bump broadcasts are throttled per post, not merged with the
// generic item batch window above - a reply still gets its own item.create batch
// entry, bump is a separate absolute-snapshot side channel.
const BUMP_THROTTLE_MS = 2_000;

const RATE_LIMIT_CAPACITY = 20;
const RATE_LIMIT_REFILL_PER_SEC = 5;

interface Attachment {
  actor: string;
  origin: string;
  room: string; // room-ref, e.g. "<stronghold>/ch/<resId>"
  role: Role;
  deny: number;
  last_seq: number;
  joined_at: number;
}

// `type` (not `interface`) so it structurally satisfies the SqlStorageValue
// index-signature constraint that sql.exec<T>() requires.
type ItemRow = {
  seq: number;
  parent_seq: number | null;
  root_seq: number | null;
  actor: string;
  origin: string;
  client_id: string;
  kind: string;
  ts: number;
  body: string;
};

// Historical item bodies may contain the removed `topics` field. Keep old
// messages readable while ensuring the retired product field never reaches a
// client again.
function withoutTopics(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { topics: _discardedTopics, ...rest } = body as Record<string, unknown>;
  return rest;
}

interface PendingEntry {
  // null = the write originated over HTTP (edit/retract endpoints),
  // there is no sender connection to exclude from the fan-out.
  senderWs: WebSocket | null;
  frame: Record<string, unknown>;
}

// Author self-edit/retract outcome. Reuses the item.update / item.delete
// broadcast shapes (m0-protocol namespacing, S5.4) - "edit"/"retract" describe the
// operation, not a new wire frame type.
export type EditOutcome =
  | { ok: true; seq: number }
  | { ok: false; code: string; message: string };
export type RetractOutcome =
  | { ok: true; seq: number | null }
  | { ok: false; code: string; message: string };

export class RoomDO extends DurableObject<Env> {
  private pendingBatch: PendingEntry[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private rateBuckets = new Map<string, { tokens: number; last: number }>();
  // proposal S4.5: per-post bump throttle state. bumpTimers only holds an entry
  // while a flush is pending (scheduled on the first reply, cleared on flush) -
  // same "timer only exists while something's queued" rule as batchTimer above,
  // so an idle section room doesn't stay artificially awake.
  private bumpTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private lastBumpAt = new Map<number, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      const content = ctx.storage.sql
        .exec<{
          n: number;
        }>(
          "SELECT (SELECT COUNT(*) FROM item) + (SELECT COUNT(*) FROM archive_search_pending) AS n",
        )
        .one().n;
      if (content > 0 && !(await ctx.storage.getAlarm()))
        await ctx.storage.setAlarm(Date.now() + ARCHIVE_ALARM_MS);
    });
  }

  // A StrongholdDO cannot delete a RoomDO's SQLite/KV namespace from the
  // outside.  Keep the destructive operation inside the object so that both
  // user data and Durable Object metadata are released together.
  async purgeForStrongholdDeletion(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4000, "stronghold deleted");
      } catch {
        // A socket may have closed between enumeration and this call.
      }
    }
    await this.ctx.storage.deleteAll();
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    // proposal S5.1 schema, verbatim table shapes. `meta` is the one addition:
    // next_seq MUST be persisted independently of the item table (S5.2) so
    // archiving rows never lets seq regress.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_event (id TEXT PRIMARY KEY,seq INTEGER UNIQUE,room TEXT NOT NULL,actor TEXT,frame TEXT NOT NULL,envelope TEXT,delivered INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS federation_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signed_event_archive (seq_start INTEGER PRIMARY KEY,seq_end INTEGER NOT NULL,r2_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item (
        seq INTEGER PRIMARY KEY,
        parent_seq INTEGER, root_seq INTEGER,
        actor TEXT NOT NULL, origin TEXT NOT NULL, client_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ts INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(origin, client_id)
      );
      CREATE INDEX IF NOT EXISTS idx_root ON item(root_seq, seq);
      CREATE TABLE IF NOT EXISTS tombstone (seq INTEGER PRIMARY KEY, actor TEXT, ts INTEGER, reason TEXT);
      CREATE TABLE IF NOT EXISTS edit (target_seq INTEGER PRIMARY KEY, seq INTEGER, body TEXT, edited_at INTEGER);
      CREATE TABLE IF NOT EXISTS dedupe_local (origin TEXT, client_id TEXT, seq INTEGER, ts INTEGER, PRIMARY KEY(origin, client_id));
      CREATE TABLE IF NOT EXISTS dedupe_fed (origin TEXT, envelope_id TEXT, ts INTEGER, PRIMARY KEY(origin, envelope_id));
      CREATE TABLE IF NOT EXISTS subscription (peer TEXT PRIMARY KEY, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS post_index (
        post_seq INTEGER PRIMARY KEY,
        last_reply_seq INTEGER NOT NULL,
        reply_count INTEGER NOT NULL DEFAULT 0,
        bumped_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_post_index_bumped ON post_index(bumped_at DESC, post_seq DESC);
      -- m0-protocol §3.2a: reaction is hot-layer engagement state only, MUST NOT
      -- enter archive shards; history beyond the hot layer is best-effort. resync
      -- replays carry each replayed item's current reaction snapshot inline - items
      -- outside that window rely on the post-reconnect read endpoints instead.
      CREATE TABLE IF NOT EXISTS reaction (
        target_seq INTEGER NOT NULL, name TEXT NOT NULL, actor TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY(target_seq, name, actor)
      );
      -- primary key already leads with target_seq, so a standalone index on just
      -- that column is a redundant left-prefix - write cost with no read benefit.
      DROP INDEX IF EXISTS idx_reaction_target;
      CREATE TABLE IF NOT EXISTS room_backup_snapshot (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_backup_snapshot ON room_backup_snapshot(backup_id, seq);
      CREATE TABLE IF NOT EXISTS room_restore_stage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_restore_stage ON room_restore_stage(backup_id, table_name, seq);
      CREATE TABLE IF NOT EXISTS archive_search_pending (target_seq INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS archive_batch_snapshot (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_archive_batch_snapshot ON archive_batch_snapshot(batch_id, row_id);
    `);
    // 标签功能已移除；旧帖子标签索引不再保留。
    sql.exec("DROP TABLE IF EXISTS post_topic;");
    sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('next_seq', 1)`);
  }

  async alarm(): Promise<void> {
    try {
      reportThreshold({
        source: "do.room.bytes",
        value: this.ctx.storage.sql.databaseSize,
        threshold: 8 * 1024 ** 3,
      });
      await this.runFederationAlarm();
      const roomRef = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key='room_ref'")
        .toArray()[0]?.value;
      if (roomRef) this.reportTip(roomRef, this.latestSequence());
      const repairedSearch = await this.repairArchiveSearch();
      const indexedPosts = await this.indexOldSectionPosts();
      const archived = await this.archiveDueItems();
      const next =
        Date.now() +
        (archived > 0 || indexedPosts >= 1_000 || repairedSearch >= 100
          ? 1_000
          : ARCHIVE_ALARM_MS);
      const pending = await this.ctx.storage.getAlarm();
      await this.ctx.storage.setAlarm(
        pending === null ? next : Math.min(pending, next),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "room.alarm",
          error: String(error),
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async archiveNow(): Promise<number> {
    return this.archiveBatch(true);
  }

  async reconcileArchiveSearch(): Promise<void> {
    await this.repairArchiveSearch();
  }

  async exportSnapshot(
    backupId: string,
    doKey: string,
  ): Promise<{ r2_key: string; sha256: string; bytes: number }> {
    if (!/^[0-9a-f-]{36}$/i.test(backupId))
      throw new Error("invalid backup id");
    const roomRef = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (roomRef && roomRef !== doKey) throw new Error("room identity mismatch");
    if (!roomRef) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('room_ref', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        doKey,
      );
    }
    const tables = this.snapshotTableNames();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM room_backup_snapshot WHERE backup_id = ?", backupId);
    this.ctx.storage.transactionSync(() => {
      for (const table of tables) {
        const columns = sql.exec(`SELECT * FROM ${table} LIMIT 0`).columnNames;
        const jsonArgs = columns
          .map((column) => `\'${column}\', \"${column}\"`)
          .join(", ");
        sql.exec(
          `INSERT INTO room_backup_snapshot (backup_id, table_name, row_json) SELECT ?, ?, json_object(${jsonArgs}) FROM ${table}`,
          backupId,
          table,
        );
      }
    });
    const snapshotKey = `backups/${encodeURIComponent(doKey)}/${backupId}.ndjson.gz`;
    const stagedRows: { seq: number; table_name: string; row_json: string }[] =
      [];
    let lastSeq = 0;
    const header = JSON.stringify({
      type: "snapshot",
      schema: 1,
      room_ref: doKey,
      tables,
      created_at: Date.now(),
    });
    let headerPending = true;
    const compressed = gzipJsonLines(async () => {
      if (headerPending) {
        headerPending = false;
        return header;
      }
      if (!stagedRows.length) {
        const page = sql
          .exec<{
            seq: number;
            table_name: string;
            row_json: string;
          }>(
            "SELECT seq, table_name, row_json FROM room_backup_snapshot WHERE backup_id = ? AND seq > ? ORDER BY seq LIMIT 100",
            backupId,
            lastSeq,
          )
          .toArray();
        stagedRows.push(...page);
      }
      const row = stagedRows.shift();
      if (!row) return null;
      lastSeq = row.seq;
      return JSON.stringify({
        type: "row",
        table: row.table_name,
        row: JSON.parse(row.row_json),
      });
    });
    try {
      await putArchiveStream(
        this.env.MEDIA,
        snapshotKey,
        compressed.stream,
        doKey,
        0,
        0,
      );
      const object = await this.env.MEDIA.head(snapshotKey);
      if (!object) throw new Error("snapshot write did not complete");
      return {
        r2_key: snapshotKey,
        sha256: compressed.getHash(),
        bytes: object.size,
      };
    } finally {
      sql.exec(
        "DELETE FROM room_backup_snapshot WHERE backup_id = ?",
        backupId,
      );
    }
  }

  async restoreSnapshot(
    backupId: string,
    r2Key: string,
    doKey: string,
    expectedSha256: string,
  ): Promise<number> {
    if (!/^[0-9a-f-]{36}$/i.test(backupId))
      throw new Error("invalid backup id");
    const currentRoomRef = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (currentRoomRef && currentRoomRef !== doKey)
      throw new Error("room identity mismatch");
    const object = await this.env.MEDIA.get(r2Key);
    if (!object?.body) throw new Error("snapshot not found");
    const availableTables = new Set(this.snapshotTableNames());
    const allowedTables = new Set([
      "meta",
      "item",
      "tombstone",
      "edit",
      "dedupe_local",
      "dedupe_fed",
      "subscription",
      "post_index",
      "reaction",
      "archive_search_pending",
      "local_event",
      "federation_state",
      "signed_event_archive",
    ]);
    const requiredTables = [
      "meta",
      "item",
      "tombstone",
      "edit",
      "dedupe_local",
      "dedupe_fed",
      "subscription",
      "post_index",
      "reaction",
    ];
    let snapshotTables: string[] = [];
    let headerSeen = false;
    let rows = 0;
    const digest = createHash("sha256");
    this.ctx.storage.sql.exec(
      "DELETE FROM room_restore_stage WHERE backup_id = ?",
      backupId,
    );
    try {
      const verifiedBody = object.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            digest.update(chunk);
            controller.enqueue(chunk);
          },
        }),
      );
      await readGzipJsonLines(verifiedBody, (record) => {
        if (!headerSeen) {
          const rowTables = record.tables;
          if (
            record.type !== "snapshot" ||
            record.schema !== 1 ||
            record.room_ref !== doKey ||
            !Array.isArray(rowTables) ||
            !rowTables.every(
              (name): name is string =>
                typeof name === "string" &&
                allowedTables.has(name) &&
                availableTables.has(name),
            ) ||
            !requiredTables.every((name) => rowTables.includes(name)) ||
            new Set(rowTables).size !== rowTables.length
          ) {
            throw new Error("snapshot room or schema mismatch");
          }
          snapshotTables = rowTables as string[];
          headerSeen = true;
          return;
        }
        if (
          record.type !== "row" ||
          typeof record.table !== "string" ||
          !allowedTables.has(record.table) ||
          !snapshotTables.includes(record.table) ||
          !record.row ||
          typeof record.row !== "object" ||
          Array.isArray(record.row)
        ) {
          throw new Error("invalid snapshot row");
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO room_restore_stage (backup_id, table_name, row_json) VALUES (?, ?, ?)",
          backupId,
          record.table,
          JSON.stringify(record.row),
        );
        rows++;
      });
      if (!headerSeen) throw new Error("snapshot header missing");
      if (digest.digest("hex") !== expectedSha256)
        throw new Error("snapshot checksum mismatch");
      const externalArchive = await this.env.DB.prepare(
        "SELECT 1 AS found FROM archive_index WHERE do_key = ? LIMIT 1",
      )
        .bind(doKey)
        .first();
      if (externalArchive) throw new Error("restore target room contains data");
      const optionalRoomTables = [
        "local_event",
        "federation_state",
        "signed_event_archive",
      ].filter((table) => availableTables.has(table));
      const optionalEmptyChecks = optionalRoomTables
        .map((table) => `(SELECT COUNT(*) FROM ${table}) = 0`)
        .join(" AND ");
      this.ctx.storage.transactionSync(() => {
        const busy = this.ctx.storage.sql
          .exec<{ busy: number }>(
            `SELECT CASE WHEN (SELECT COUNT(*) FROM item) = 0 AND (SELECT COUNT(*) FROM tombstone) = 0 AND
           (SELECT COUNT(*) FROM edit) = 0 AND (SELECT COUNT(*) FROM dedupe_local) = 0 AND
           (SELECT COUNT(*) FROM dedupe_fed) = 0 AND (SELECT COUNT(*) FROM post_index) = 0 AND
           (SELECT COUNT(*) FROM reaction) = 0 AND (SELECT COUNT(*) FROM subscription) = 0 AND
           (SELECT COUNT(*) FROM archive_search_pending) = 0 AND
           ${optionalEmptyChecks || "1 = 1"} AND
           (SELECT COUNT(*) FROM meta WHERE key IN ('archive_pending_start', 'archive_pending_end')) = 0 AND
           (SELECT value FROM meta WHERE key = 'next_seq') = 1 THEN 0 ELSE 1 END AS busy`,
          )
          .one().busy;
        if (busy) throw new Error("restore target room contains data");
        for (const table of snapshotTables) {
          const columns = this.ctx.storage.sql.exec(
            `SELECT * FROM ${table} LIMIT 0`,
          ).columnNames;
          const quotedColumns = columns
            .map((column) => `\"${column}\"`)
            .join(", ");
          const values = columns
            .map((column) => `json_extract(row_json, '$.${column}')`)
            .join(", ");
          const conflict = table === "meta" ? "OR REPLACE " : "";
          this.ctx.storage.sql.exec(
            `INSERT ${conflict}INTO ${table} (${quotedColumns}) SELECT ${values} FROM room_restore_stage WHERE backup_id = ? AND table_name = ? ORDER BY seq`,
            backupId,
            table,
          );
        }
      });
      return rows;
    } finally {
      this.ctx.storage.sql.exec(
        "DELETE FROM room_restore_stage WHERE backup_id = ?",
        backupId,
      );
    }
  }

  private async archiveDueItems(): Promise<number> {
    return this.archiveBatch(false);
  }

  private async archiveBatch(force: boolean): Promise<number> {
    const roomRef = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    const isSection = roomRef?.split("/")[1] === "sec";
    const eligible = isSection ? "parent_seq IS NOT NULL" : "1 = 1";
    const stats = this.ctx.storage.sql
      .exec<{
        count: number;
        oldest: number | null;
      }>(
        `SELECT COUNT(*) AS count, MIN(ts) AS oldest FROM item WHERE ${eligible}`,
      )
      .one();
    if (
      !stats.count ||
      (!force &&
        stats.count <= HOT_ITEM_LIMIT &&
        (stats.oldest ?? Date.now()) > Date.now() - HOT_AGE_MS)
    )
      return 0;

    const cutoff = Date.now() - HOT_AGE_MS;
    const archiveFilter =
      !force && stats.count <= HOT_ITEM_LIMIT
        ? `(${eligible}) AND ts <= ${cutoff}`
        : eligible;
    let candidates = this.ctx.storage.sql
      .exec<{
        seq: number;
        ts: number;
      }>(
        `SELECT seq, ts FROM item WHERE ${eligible} ORDER BY seq ASC LIMIT ?`,
        ARCHIVE_SHARD_ITEMS,
      )
      .toArray();
    if (!force && stats.count <= HOT_ITEM_LIMIT) {
      candidates = candidates.filter((row) => row.ts <= cutoff);
    }
    if (!candidates.length) return 0;

    const start = candidates[0]!.seq;
    const end = candidates[candidates.length - 1]!.seq;
    const doKey = roomRef ?? "unresolved";
    const r2Key = archiveObjectKey(doKey, start, end);
    const batchId = crypto.randomUUID();
    const sql = this.ctx.storage.sql;
    const itemColumns = sql.exec("SELECT * FROM item LIMIT 0").columnNames;
    const itemJson = itemColumns
      .map((column) => `\'${column}\', \"${column}\"`)
      .join(", ");
    const postColumns = sql.exec(
      "SELECT * FROM post_index LIMIT 0",
    ).columnNames;
    const postJson = postColumns
      .map((column) => `\'${column}\', \"${column}\"`)
      .join(", ");
    sql.exec("DELETE FROM archive_batch_snapshot WHERE batch_id = ?", batchId);
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO archive_batch_snapshot (batch_id, record_type, row_json) ` +
          `SELECT ?, 'item', json_object(${itemJson}) FROM item WHERE ${archiveFilter} AND seq BETWEEN ? AND ? ORDER BY seq DESC`,
        batchId,
        start,
        end,
      );
      sql.exec(
        `INSERT INTO archive_batch_snapshot (batch_id, record_type, row_json) ` +
          `SELECT ?, 'post_index', json_object(${postJson}) FROM post_index WHERE post_seq BETWEEN ? AND ? ORDER BY post_seq`,
        batchId,
        start,
        end,
      );
    });
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('archive_pending_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      start,
    );
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('archive_pending_end', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      end,
    );
    let lastRowId = 0;
    const stagedRows: {
      row_id: number;
      record_type: string;
      row_json: string;
    }[] = [];
    const compressed = gzipJsonLines(async () => {
      if (!stagedRows.length) {
        stagedRows.push(
          ...sql
            .exec<{
              row_id: number;
              record_type: string;
              row_json: string;
            }>(
              "SELECT row_id, record_type, row_json FROM archive_batch_snapshot WHERE batch_id = ? AND row_id > ? ORDER BY row_id LIMIT 100",
              batchId,
              lastRowId,
            )
            .toArray(),
        );
      }
      const row = stagedRows.shift();
      if (!row) return null;
      lastRowId = row.row_id;
      return JSON.stringify({
        type: row.record_type,
        row: JSON.parse(row.row_json),
      });
    });

    try {
      await putArchiveStream(
        this.env.MEDIA,
        r2Key,
        compressed.stream,
        doKey,
        start,
        end,
      );
      const checksum = compressed.getHash();
      let searchRowId = 0;
      while (true) {
        const batch = sql
          .exec<{
            row_id: number;
            row_json: string;
          }>(
            "SELECT row_id, row_json FROM archive_batch_snapshot WHERE batch_id = ? AND record_type = 'item' AND row_id > ? ORDER BY row_id LIMIT 50",
            batchId,
            searchRowId,
          )
          .toArray();
        if (!batch.length) break;
        searchRowId = batch[batch.length - 1]!.row_id;
        const items = batch.map(
          (entry) => JSON.parse(entry.row_json) as ArchiveItem,
        );
        const seqs = items.map((row) => String(row.seq));
        const prior = await this.env.DB.prepare(
          `SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq IN (${seqs.map(() => "?").join(",")})`,
        )
          .bind(doKey, ...seqs)
          .all<{
            rowid: number;
            do_key: string;
            seq: string;
            text: string;
            actor: string;
            ts: string;
            kind: string;
            root_seq: string;
          }>();
        const statements = prior.results.map((row) =>
          this.env.DB.prepare(
            "INSERT INTO archive_search(archive_search, rowid, do_key, seq, text, actor, ts, kind, root_seq) VALUES ('delete', ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            row.rowid,
            row.do_key,
            row.seq,
            row.text,
            row.actor,
            row.ts,
            row.kind,
            row.root_seq,
          ),
        );
        statements.push(
          this.env.DB.prepare(
            `DELETE FROM archive_document WHERE do_key = ? AND seq IN (${seqs.map(() => "?").join(",")})`,
          ).bind(doKey, ...seqs),
        );
        await this.env.DB.batch(statements);

        const searchStatements = [];
        for (const row of items) {
          const tombstone = sql
            .exec<{
              seq: number;
            }>("SELECT seq FROM tombstone WHERE seq = ?", row.seq)
            .toArray()[0];
          if (tombstone) continue;
          const edit = sql
            .exec<{
              body: string;
            }>("SELECT body FROM edit WHERE target_seq = ?", row.seq)
            .toArray()[0];
          const text = searchableText(edit?.body ?? row.body);
          searchStatements.push(
            this.env.DB.prepare(
              "INSERT INTO archive_document (do_key, seq, text, actor, ts, kind, root_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).bind(
              doKey,
              String(row.seq),
              text,
              row.actor,
              String(row.ts),
              row.kind,
              row.root_seq == null ? "" : String(row.root_seq),
            ),
            this.env.DB.prepare(
              "INSERT INTO archive_search(rowid, do_key, seq, text, actor, ts, kind, root_seq) " +
                "SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq = ?",
            ).bind(doKey, String(row.seq)),
          );
        }
        if (searchStatements.length) await this.env.DB.batch(searchStatements);
      }
      await this.env.DB.prepare(
        "INSERT INTO archive_index (do_key, seq_start, seq_end, r2_key, shard_version, created_at, content_sha256, item_count) " +
          "VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(do_key, seq_start) DO UPDATE SET seq_end = excluded.seq_end, r2_key = excluded.r2_key, " +
          "content_sha256 = excluded.content_sha256, item_count = excluded.item_count",
      )
        .bind(doKey, start, end, r2Key, Date.now(), checksum, candidates.length)
        .run();

      sql.exec(
        `DELETE FROM item WHERE ${archiveFilter} AND seq BETWEEN ? AND ?`,
        start,
        end,
      );
      sql.exec(
        "DELETE FROM meta WHERE key IN ('archive_pending_start', 'archive_pending_end')",
      );
      await this.repairArchiveSearch();
      return candidates.length;
    } finally {
      sql.exec(
        "DELETE FROM archive_batch_snapshot WHERE batch_id = ?",
        batchId,
      );
    }
  }

  private isInArchiveBatch(seq: number): boolean {
    const bounds = this.ctx.storage.sql
      .exec<{
        key: string;
        value: number;
      }>(
        "SELECT key, value FROM meta WHERE key IN ('archive_pending_start', 'archive_pending_end')",
      )
      .toArray();
    const values = new Map(bounds.map((row) => [row.key, row.value]));
    const start = values.get("archive_pending_start");
    const end = values.get("archive_pending_end");
    return start != null && end != null && seq >= start && seq <= end;
  }

  private isSearchIndexedPost(item: ItemRow): boolean {
    if (item.kind !== "post" || item.parent_seq != null) return false;
    const cursor = this.ctx.storage.sql
      .exec<{
        value: number;
      }>("SELECT value FROM meta WHERE key = 'post_search_cursor'")
      .toArray()[0]?.value;
    return cursor != null && item.seq <= cursor;
  }

  private async indexOldSectionPosts(): Promise<number> {
    const roomRef = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (roomRef?.split("/")[1] !== "sec") return 0;
    const cursor =
      this.ctx.storage.sql
        .exec<{
          value: number;
        }>("SELECT value FROM meta WHERE key = 'post_search_cursor'")
        .toArray()[0]?.value ?? 0;
    const currentMax = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>("SELECT value - 1 AS seq FROM meta WHERE key = 'next_seq'")
      .one().seq;
    const posts = this.ctx.storage.sql
      .exec<
        ItemRow & {
          edit_body: string | null;
          tomb_seq: number | null;
        }
      >(
        `SELECT i.*, e.body AS edit_body, t.seq AS tomb_seq FROM item i
       LEFT JOIN edit e ON e.target_seq = i.seq LEFT JOIN tombstone t ON t.seq = i.seq
       WHERE i.seq > ? AND i.parent_seq IS NULL AND i.kind = 'post' AND i.ts <= ? AND t.seq IS NULL
       ORDER BY i.seq LIMIT 1000`,
        cursor,
        Date.now() - HOT_AGE_MS,
      )
      .toArray();
    for (let offset = 0; offset < posts.length; offset += 30) {
      const batch = posts.slice(offset, offset + 30);
      const seqs = batch.map((row) => String(row.seq));
      const prior = await this.env.DB.prepare(
        `SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq IN (${seqs.map(() => "?").join(",")})`,
      )
        .bind(roomRef, ...seqs)
        .all<{
          rowid: number;
          do_key: string;
          seq: string;
          text: string;
          actor: string;
          ts: string;
          kind: string;
          root_seq: string;
        }>();
      const statements = prior.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO archive_search(archive_search, rowid, do_key, seq, text, actor, ts, kind, root_seq) VALUES ('delete', ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          row.rowid,
          row.do_key,
          row.seq,
          row.text,
          row.actor,
          row.ts,
          row.kind,
          row.root_seq,
        ),
      );
      for (const row of batch) {
        statements.push(
          this.env.DB.prepare(
            "INSERT OR REPLACE INTO archive_document (do_key, seq, text, actor, ts, kind, root_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            roomRef,
            String(row.seq),
            searchableText(row.edit_body ?? row.body),
            row.actor,
            String(row.ts),
            row.kind,
            String(row.seq),
          ),
          this.env.DB.prepare(
            "INSERT INTO archive_search(rowid, do_key, seq, text, actor, ts, kind, root_seq) " +
              "SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq = ?",
          ).bind(roomRef, String(row.seq)),
        );
      }
      if (statements.length) await this.env.DB.batch(statements);
    }
    const nextCursor =
      posts.length === 1_000 ? posts[posts.length - 1]!.seq : currentMax;
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('post_search_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      nextCursor,
    );
    return posts.length;
  }

  // S5.1/S5.2: next_seq lives only here, bumped atomically with the RETURNING trick
  // (single synchronous sql.exec, no await - coalesced with whatever write follows).
  private allocateSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>(
        "UPDATE meta SET value = value + 1 WHERE key = 'next_seq' RETURNING value - 1 AS seq",
      )
      .one();
    return row.seq;
  }

  // ---- edit-policy snapshot ---------------------------------------------------
  // StrongholdDO pushes {allow_message_edit, allow_message_retract, edit_window_secs}
  // here on every config change (DO-to-DO, fire-and-forget); three extra `meta` rows
  // piggyback on the table that already exists for next_seq rather than opening a
  // second one. Query-back (ensureEditConfig) covers a room that never got a push
  // yet (created after the stronghold's last config change, or a missed delivery).

  private readEditConfig(): EditConfigSnapshot | null {
    const rows = this.ctx.storage.sql
      .exec<{
        key: string;
        value: number;
      }>(
        "SELECT key, value FROM meta WHERE key IN ('allow_message_edit', 'allow_message_retract', 'edit_window_secs')",
      )
      .toArray();
    if (rows.length < 3) return null;
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return {
      allow_message_edit: byKey.get("allow_message_edit") === 1,
      allow_message_retract: byKey.get("allow_message_retract") === 1,
      edit_window_secs: byKey.get("edit_window_secs") ?? 0,
    };
  }

  private persistEditConfig(cfg: EditConfigSnapshot): void {
    const entries: [string, number][] = [
      ["allow_message_edit", cfg.allow_message_edit ? 1 : 0],
      ["allow_message_retract", cfg.allow_message_retract ? 1 : 0],
      ["edit_window_secs", cfg.edit_window_secs],
    ];
    for (const [key, value] of entries) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
    }
  }

  private snapshotTableNames(): string[] {
    const candidates = [
      "meta",
      "item",
      "tombstone",
      "edit",
      "dedupe_local",
      "dedupe_fed",
      "subscription",
      "post_index",
      "reaction",
      "archive_search_pending",
      "local_event",
      "federation_state",
      "signed_event_archive",
    ];
    const existing = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .toArray()
        .map((row) => row.name),
    );
    return candidates.filter((name) => existing.has(name));
  }

  // DO-to-DO push target, called by StrongholdDO.updateConfig.
  async setEditConfig(cfg: EditConfigSnapshot): Promise<void> {
    this.persistEditConfig(cfg);
  }

  private readFeatureRestrictions(): FeatureRestrictionSnapshot | null {
    const rows = this.ctx.storage.sql
      .exec<{
        key: string;
        value: string;
      }>("SELECT key, value FROM meta WHERE key = 'feature_restrictions'")
      .toArray();
    if (!rows[0]) return null;
    try {
      const value = JSON.parse(rows[0].value) as FeatureRestrictionSnapshot;
      return value?.chat && value?.posts ? value : null;
    } catch {
      return null;
    }
  }

  private persistFeatureRestrictions(
    snapshot: FeatureRestrictionSnapshot,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('feature_restrictions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(snapshot),
    );
  }

  async setFeatureRestrictions(
    snapshot: FeatureRestrictionSnapshot,
  ): Promise<void> {
    this.persistFeatureRestrictions(snapshot);
  }

  private async ensureFeatureRestrictions(
    strongholdId: string,
  ): Promise<FeatureRestrictionSnapshot> {
    const cached = this.readFeatureRestrictions();
    try {
      // Query back for every item.create. The durable snapshot remains the
      // fallback for a transient RPC outage, but cannot permanently conceal a
      // failed or newly-applied policy push from an old websocket.
      const fetched =
        await this.env.STRONGHOLD_DO.getByName(
          strongholdId,
        ).getFeatureRestrictions();
      if (fetched) {
        this.persistFeatureRestrictions(fetched);
        return fetched;
      }
    } catch {
      if (cached) return cached;
    }
    const snapshot = cached ?? {
      chat: {
        owner_paused: false,
        owner_expires_at: null,
        server_override: "inherit" as const,
        server_expires_at: null,
      },
      posts: {
        owner_paused: false,
        owner_expires_at: null,
        server_override: "inherit" as const,
        server_expires_at: null,
      },
    };
    this.persistFeatureRestrictions(snapshot);
    return snapshot;
  }

  // ---- revocation propagation (m0-protocol §7.3) --------------------------------
  // DO-to-DO push target, called by StrongholdDO on ban/kick/role-deny/group
  // mutations. Local-only (no seq, no dedupe table, never federated). Scans every
  // live connection rather than tracking actor->ws separately - Hibernation WS
  // sets are already the source of truth and this only runs on a revoke, not per
  // message.
  async setFederationVisibility(
    roomRef: string,
    isPublic: boolean,
    forceBoundary = false,
  ): Promise<void> {
    const previous = this.ctx.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM meta WHERE key='federation_visibility'")
      .toArray()[0]?.value;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO meta(key,value) VALUES ('room_ref',?)",
        roomRef,
      );
      if (isPublic && (previous === "private" || forceBoundary)) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO meta(key,value) VALUES ('public_history_floor',?)",
          this.latestSequence() + 1,
        );
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO meta(key,value) VALUES ('public_history_at',?)",
          Date.now(),
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO meta(key,value) VALUES ('federation_visibility',?)",
        isPublic ? "public" : "private",
      );
    });
  }
  private publicHistoryFloor(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{
          value: number;
        }>("SELECT value FROM meta WHERE key='public_history_floor'")
        .toArray()[0]?.value ?? 0,
    );
  }
  private async viewerHistoryFloor(actor: string | null): Promise<number> {
    const floor = this.publicHistoryFloor();
    if (!floor || !actor) return floor;
    const rows = this.ctx.storage.sql
      .exec<{
        key: string;
        value: string;
      }>(
        "SELECT key,value FROM meta WHERE key IN ('federation_visibility','public_history_at','room_ref')",
      )
      .toArray();
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    if (meta.federation_visibility === "private") return 0;
    const stronghold = this.env.STRONGHOLD_DO.getByName(
      String(meta.room_ref).split("/")[0]!,
    );
    const [permissions, member] = await Promise.all([
      stronghold.getSocketPermissions(actor),
      stronghold.getMember(actor),
    ]);
    return permissions &&
      (permissions.role !== "member" ||
        (member && member.joined_at < Number(meta.public_history_at)))
      ? 0
      : floor;
  }
  private socketHistoryFloor(attachment: Attachment | null): number {
    const at = Number(
      this.ctx.storage.sql
        .exec<{
          value: number;
        }>("SELECT value FROM meta WHERE key='public_history_at'")
        .toArray()[0]?.value ?? 0,
    );
    return attachment &&
      (attachment.role !== "member" || attachment.joined_at < at)
      ? 0
      : this.publicHistoryFloor();
  }
  private async publicEnvelope(event: Envelope): Promise<Envelope | null> {
    const reference = Number(
      event.payload.target_seq ??
        event.payload.root_seq ??
        event.payload.post_seq ??
        event.seq ??
        0,
    );
    if (
      reference >= this.publicHistoryFloor() &&
      event.audience !== "members"
    ) {
      return event;
    }
    return event.seq
      ? newEvent(
          this.env,
          "item.delete",
          { target_seq: event.seq, reason: "private_history" },
          { room: event.room, seq: event.seq, id: event.id, ts: event.ts },
        )
      : null;
  }

  async closeForRoomRestriction(all = false): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!all && attachment && attachment.role !== "member") continue;
      try {
        ws.close(1008, "OMEW_ROOM_NOT_FOUND");
      } catch {}
    }
  }
  async revokeMember(payload: MemberRevokePayload): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.actor !== payload.actor) continue;

      if (payload.effect === "close") {
        try {
          ws.close(1008, "OMEW_SESSION_INVALID");
        } catch {
          // socket already gone.
        }
        continue;
      }

      attachment.role = payload.role ?? attachment.role;
      attachment.deny = payload.deny ?? attachment.deny;
      ws.serializeAttachment(attachment);
    }
  }

  private async ensureEditConfig(
    strongholdId: string,
  ): Promise<EditConfigSnapshot> {
    const cached = this.readEditConfig();
    if (cached) return cached;
    const stub = this.env.STRONGHOLD_DO.getByName(strongholdId);
    const config = await stub.getConfig();
    const fetched: EditConfigSnapshot = config
      ? {
          allow_message_edit: Boolean(config.allow_message_edit),
          allow_message_retract: Boolean(config.allow_message_retract),
          edit_window_secs: config.edit_window_secs,
        }
      : {
          allow_message_edit: true,
          allow_message_retract: true,
          edit_window_secs: 300,
        };
    this.persistEditConfig(fetched);
    return fetched;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
    if (!protocolHeader) {
      return new Response("missing token", { status: 401 });
    }
    const token = protocolHeader.trim();
    const claims = await verifyToken<RoomTokenClaims>(
      token,
      this.env.DEV_TOKEN_SECRET,
    );
    if (
      !claims ||
      claims.typ !== "room" ||
      !this.env.ROOM_DO.idFromName(claims.room).equals(this.ctx.id)
    ) {
      return new Response("invalid token", { status: 401 });
    }
    const socketEnv = withRequestInstanceDomain(
      this.env,
      new URL(request.url).hostname,
    );
    if (!(await socketActorIsActive(socketEnv, claims)))
      return new Response("invalid account", { status: 401 });
    const [strongholdId, , resId] = claims.room.split("/");
    const stronghold = this.env.STRONGHOLD_DO.getByName(strongholdId!);
    const [permissions, room] = await Promise.all([
      stronghold.getSocketPermissions(claims.actor, instanceDomain(socketEnv)),
      stronghold.getRoom(resId!),
    ]);
    if (
      !permissions ||
      !room ||
      room.archived ||
      !canAccessRestrictedRoom(permissions.role, room)
    )
      return new Response("access revoked", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      actor: claims.actor,
      origin: instanceDomain(this.env, new URL(request.url).hostname),
      room: claims.room,
      role: permissions.role,
      deny: permissions.deny,
      last_seq: 0,
      joined_at: permissions.joined_at,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('room_ref', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      claims.room,
    );
    server.serializeAttachment(attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": token },
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    if (new TextEncoder().encode(message).length > 60_000) {
      this.sendError(ws, "OMEW_ENVELOPE_TOO_LARGE", "message too large");
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      ws.close(1011, "no attachment");
      return;
    }

    if (!this.takeRateToken(attachment.actor)) {
      this.sendError(ws, "OMEW_RATE_LIMITED", "too many messages");
      return;
    }

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message);
    } catch {
      this.sendError(ws, "OMEW_MALFORMED", "invalid json");
      return;
    }

    switch (frame.type) {
      case "item.create":
        await this.handleItemCreate(ws, attachment, frame);
        return;
      case "item.update":
        await this.handleItemUpdate(ws, attachment, frame);
        return;
      case "item.delete":
        await this.handleItemDelete(ws, attachment, frame);
        return;
      case "item.reaction":
        await this.handleItemReaction(ws, attachment, frame);
        return;
      case "resync":
        await this.handleResync(ws, frame);
        return;
      default:
        // m0-protocol S13.2: unknown types are silently ignored, no error frame.
        return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    try {
      // Echo the close so the Hibernation API completes the handshake on our side.
      // Reserved codes (e.g. 1005 "no status received", reported when the client
      // closed without one) MUST NOT be sent explicitly - fall back to a plain close.
      ws.close(code, reason);
    } catch {
      ws.close();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // Hibernation API surfaces the failure; nothing durable to clean up since
    // attachment/session state lives only on the socket itself.
  }

  // ---- item.* handlers -----------------------------------------------------

  private async handleItemCreate(
    ws: WebSocket,
    attachment: Attachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const clientId = String(frame.client_id ?? "");
    const kind = String(frame.kind ?? "");
    const parentSeq =
      frame.parent_seq == null ? null : Number(frame.parent_seq);
    let body = frame.body;

    if (!clientId || clientId.length > 64) {
      this.sendError(ws, "OMEW_MALFORMED", "bad client_id");
      return;
    }
    if (kind !== "post" && kind !== "reply") {
      // m0-protocol S3.2: unknown kind is treated like unknown type - ignored, not an error.
      this.sendAck(ws, {
        status: "ignored",
        client_id: clientId,
        reason: "unknown_kind",
      });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.sendError(ws, "OMEW_MALFORMED", "body must be an object");
      return;
    }
    try {
      body = this.normalizedBody(body);
    } catch {
      this.sendError(
        ws,
        "OMEW_MALFORMED",
        "body cannot be represented in a signed event",
      );
      return;
    }
    const b = body as Record<string, unknown>;
    if ("topics" in b) {
      this.sendError(ws, "OMEW_MALFORMED", "topics are no longer supported");
      return;
    }
    if (!b.text && !b.media && !b.quote) {
      this.sendError(ws, "OMEW_MALFORMED", "body needs text, media or quote");
      return;
    }

    const roomKind = attachment.room.split("/")[1]; // "ch" | "sec"
    const isTopLevel = parentSeq == null;

    // Section-real (proposal S4.5 / S5.4): kind stays {post, reply} everywhere -
    // the channel/section split is a body-shape + threading matrix, not a new kind.
    // A channel's flat chat MUST NOT carry post/reply structure (no title, no
    // parent); a section's top-level item MUST be a real titled post, and anything
    // under a post MUST be a reply.
    if (roomKind === "ch") {
      if (kind !== "post" || !isTopLevel || typeof b.title === "string") {
        this.sendError(
          ws,
          "OMEW_KIND_INVALID_FOR_ROOM",
          "channels only accept plain messages",
        );
        return;
      }
    } else if (isTopLevel) {
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (
        kind !== "post" ||
        !title ||
        title.length > POST_TITLE_MAX ||
        typeof b.text !== "string" ||
        !b.text
      ) {
        this.sendError(
          ws,
          "OMEW_KIND_INVALID_FOR_ROOM",
          `sections require a titled post (title <= ${POST_TITLE_MAX} chars, text required)`,
        );
        return;
      }
    } else if (kind !== "reply") {
      this.sendError(
        ws,
        "OMEW_KIND_INVALID_FOR_ROOM",
        "sections only accept replies under a post",
      );
      return;
    }

    const isSectionPost = roomKind === "sec" && isTopLevel;
    const feature = roomKind === "ch" ? "chat" : "posts";
    const strongholdId = attachment.room.split("/")[0]!;
    const restrictions = await this.ensureFeatureRestrictions(strongholdId);
    if (featurePaused(restrictions[feature])) {
      this.sendError(
        ws,
        "OMEW_FEATURE_RESTRICTED",
        `${feature} is temporarily paused`,
      );
      return;
    }

    const requiredBit =
      parentSeq != null
        ? DENY_SECTION_REPLY
        : roomKind === "sec"
          ? DENY_SECTION_POST
          : DENY_CHANNEL_SPEAK;
    if (attachment.deny & requiredBit) {
      this.sendError(ws, "OMEW_FORBIDDEN", "denied by member state");
      return;
    }

    // The WS handshake records the public request host because later socket
    // frames run without a Request object.
    const homeOrigin = attachment.origin;

    const existing = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>(
        "SELECT seq FROM dedupe_local WHERE origin = ? AND client_id = ?",
        homeOrigin,
        clientId,
      )
      .toArray();
    if (existing.length > 0) {
      this.sendAck(ws, {
        status: "duplicate",
        client_id: clientId,
        seq: existing[0]!.seq,
      });
      return;
    }

    let rootSeq: number | null = null;
    if (parentSeq != null) {
      const parent = this.ctx.storage.sql
        .exec<ItemRow>("SELECT * FROM item WHERE seq = ?", parentSeq)
        .toArray();
      if (parent.length === 0) {
        this.sendError(ws, "OMEW_TARGET_NOT_FOUND", "parent not found");
        return;
      }
      if (parent[0]!.parent_seq != null) {
        this.sendError(ws, "OMEW_REPLY_DEPTH", "reply depth exceeds one level");
        return;
      }
      rootSeq = parent[0]!.seq;
    }

    const ts = Date.now();
    const seq = this.allocateSeq();
    rootSeq = rootSeq ?? seq;

    // Section post: preview is derived server-side and folded into the stored
    // body (proposal S4.5) so list reads never need to recompute it.
    const finalBody: unknown = isSectionPost
      ? { ...b, preview: markdownPreview(b.text as string, PREVIEW_LEN) }
      : b;
    const bodyJson = JSON.stringify(finalBody);
    this.ctx.storage.sql.exec(
      "INSERT INTO item (seq, parent_seq, root_seq, actor, origin, client_id, kind, ts, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      seq,
      parentSeq,
      rootSeq,
      attachment.actor,
      homeOrigin,
      clientId,
      kind,
      ts,
      bodyJson,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO dedupe_local (origin, client_id, seq, ts) VALUES (?, ?, ?, ?)",
      homeOrigin,
      clientId,
      seq,
      ts,
    );

    if (isSectionPost) {
      this.ctx.storage.sql.exec(
        "INSERT INTO post_index (post_seq, last_reply_seq, reply_count, bumped_at) VALUES (?, ?, 0, ?)",
        seq,
        seq,
        ts,
      );
    } else if (roomKind === "sec" && !isTopLevel) {
      // Sort/bump index updates synchronously and always (absolute, idempotent);
      // only the broadcast of that state is throttled, in scheduleBump below.
      this.ctx.storage.sql.exec(
        "INSERT INTO post_index (post_seq, last_reply_seq, reply_count, bumped_at) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT(post_seq) DO UPDATE SET last_reply_seq = excluded.last_reply_seq, " +
          "reply_count = post_index.reply_count + 1, bumped_at = excluded.bumped_at",
        rootSeq,
        seq,
        ts,
      );
      this.scheduleBump(rootSeq);
    }

    const createdFrame = {
      type: "item.create",
      seq,
      parent_seq: parentSeq,
      root_seq: rootSeq,
      actor: attachment.actor,
      kind,
      ts,
      body: finalBody,
      client_id: clientId,
    };
    const signed = this.appendSignedEvent(
      attachment.room,
      attachment.actor,
      createdFrame,
    );
    this.scheduleArchiveAlarm();
    this.sendAck(ws, { status: "ok", client_id: clientId, seq });
    const envelope = await signed;
    this.enqueueBroadcast(ws, { ...createdFrame, envelope });
    this.reportTip(attachment.room, seq);
  }

  private async handleItemUpdate(
    ws: WebSocket,
    attachment: Attachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const targetSeq = Number(frame.target_seq);
    const body = frame.body;
    if (!Number.isFinite(targetSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.update");
      return;
    }
    const result = await this.performEdit(
      attachment.actor,
      attachment.room,
      targetSeq,
      body,
      ws,
    );
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }
    this.sendAck(ws, { status: "ok", target_seq: targetSeq, seq: result.seq });
  }

  private async handleItemDelete(
    ws: WebSocket,
    attachment: Attachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const targetSeq = Number(frame.target_seq);
    const reason = frame.reason == null ? undefined : String(frame.reason);
    if (!Number.isFinite(targetSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.delete");
      return;
    }
    const result = await this.performRetract(
      attachment.actor,
      attachment.role,
      attachment.room,
      targetSeq,
      reason,
      ws,
    );
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }
    // m0-protocol S3.2: repeated item.delete is an idempotent no-op - result.seq is
    // null when the target was already tombstoned, no new event was broadcast.
    this.sendAck(
      ws,
      result.seq == null
        ? { status: "ok", target_seq: targetSeq }
        : { status: "ok", target_seq: targetSeq, seq: result.seq },
    );
  }

  // m0-protocol §3.2a: engagement toggle, never occupies seq, not gated by deny
  // bits. Rate limiting is already applied once per frame in webSocketMessage
  // above (shared actor bucket), so this handler doesn't take a token itself.
  private async handleItemReaction(
    ws: WebSocket,
    attachment: Attachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (!getInstanceBranding(this.env).reactions_enabled) {
      this.sendError(ws, "OMEW_FEATURE_DISABLED", "reactions are disabled");
      return;
    }
    const rawTargetSeq = frame.target_seq;
    const rawName = frame.name;
    const op = frame.op;

    // Guard types before coercing: Number()/String() would turn {} into
    // "[object Object]" (storable) and true into 1 (addressable) rather than
    // rejecting them. Echo back whatever locator the frame carried, even if
    // it fails validation, so the client can still match this reply to its
    // pending optimistic update.
    if (typeof rawName !== "string" || !Number.isSafeInteger(rawTargetSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.reaction", {
        target_seq: rawTargetSeq,
        name: rawName,
      });
      return;
    }
    const targetSeq = rawTargetSeq as number;
    const name = rawName;
    if (
      !/^[\x20-\x7e]{1,64}$/.test(name) ||
      (op !== "add" && op !== "remove")
    ) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.reaction", {
        target_seq: targetSeq,
        name,
      });
      return;
    }

    const target = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM item WHERE seq = ?", targetSeq)
      .toArray();
    if (target.length === 0) {
      this.sendError(ws, "OMEW_TARGET_NOT_FOUND", "target not found", {
        target_seq: targetSeq,
        name,
      });
      return;
    }
    const tomb = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq)
      .toArray();
    if (tomb.length > 0) {
      this.sendError(ws, "OMEW_ITEM_DELETED", "target already deleted", {
        target_seq: targetSeq,
        name,
      });
      return;
    }

    // Per-(actor, target, name) toggle is idempotent: duplicate add and a
    // missing remove are silent no-ops, never errors.
    if (op === "add") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO reaction (target_seq, name, actor, ts) VALUES (?, ?, ?, ?)",
        targetSeq,
        name,
        attachment.actor,
        Date.now(),
      );
    } else {
      this.ctx.storage.sql.exec(
        "DELETE FROM reaction WHERE target_seq = ? AND name = ? AND actor = ?",
        targetSeq,
        name,
        attachment.actor,
      );
    }

    const entries = this.ctx.storage.sql
      .exec<{
        name: string;
        count: number;
      }>(
        "SELECT name, COUNT(*) AS count FROM reaction WHERE target_seq = ? GROUP BY name ORDER BY name",
        targetSeq,
      )
      .toArray();

    // Absolute snapshot, same shape to sender and everyone else - sender gets it
    // immediately (not batched), the rest via the usual batching window.
    const reaction = {
      type: "item.reaction",
      target_seq: targetSeq,
      entries,
      actor: attachment.actor,
      name,
      op,
    };
    const envelope = await this.appendSignedEvent(
      attachment.room,
      attachment.actor,
      reaction,
    );
    const responseFrame = { ...reaction, envelope };
    try {
      ws.send(JSON.stringify(responseFrame));
    } catch {
      // socket already gone; the broadcast below still reaches everyone else.
    }
    this.enqueueBroadcast(ws, responseFrame);
  }

  // HTTP entry points for the same edit/retract operations (api.ts), for clients
  // that aren't holding the room's WS open. Core logic and the
  // item.update/item.delete broadcast are shared with the WS frame handlers above.
  async editItem(
    actor: string,
    roomRef: string,
    targetSeq: number,
    content: unknown,
  ): Promise<EditOutcome> {
    return this.performEdit(actor, roomRef, targetSeq, content, null);
  }

  async retractItem(
    actor: string,
    role: Role,
    roomRef: string,
    targetSeq: number,
    reason?: string,
  ): Promise<RetractOutcome> {
    return this.performRetract(actor, role, roomRef, targetSeq, reason, null);
  }

  // Author self-edit: gated by the stronghold's allow_message_edit switch and
  // edit_window_secs window (0 = unlimited), measured from the target item's ts.
  // Editing someone else's item is never allowed, regardless of role - only
  // retraction has a moderator override (§9: owner/mod delete = review power).
  private async performEdit(
    actor: string,
    roomRef: string,
    targetSeq: number,
    body: unknown,
    excludeWs: WebSocket | null,
  ): Promise<EditOutcome> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        ok: false,
        code: "OMEW_MALFORMED",
        message: "body must be an object",
      };
    }
    try {
      body = this.normalizedBody(body);
    } catch {
      return {
        ok: false,
        code: "OMEW_MALFORMED",
        message: "body cannot be represented in a signed event",
      };
    }
    let target = this.ctx.storage.sql
      .exec<ItemRow>("SELECT * FROM item WHERE seq = ?", targetSeq)
      .toArray();
    let archivedTarget = false;
    if (target.length === 0) {
      const archived = await this.findArchivedItem(targetSeq);
      if (archived) {
        target = [archived];
        archivedTarget = true;
      }
    }
    if (target.length === 0) {
      return {
        ok: false,
        code: "OMEW_TARGET_NOT_FOUND",
        message: "target not found",
      };
    }
    const tomb = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq)
      .toArray();
    if (tomb.length > 0) {
      return {
        ok: false,
        code: "OMEW_ITEM_DELETED",
        message: "target already deleted",
      };
    }
    if (target[0]!.actor !== actor) {
      return {
        ok: false,
        code: "OMEW_FORBIDDEN",
        message: "only the author may edit",
      };
    }

    const strongholdId = roomRef.split("/")[0]!;
    const cfg = await this.ensureEditConfig(strongholdId);
    if (!cfg.allow_message_edit) {
      return {
        ok: false,
        code: "EDIT_DISABLED",
        message: "message editing is disabled for this stronghold",
      };
    }
    if (
      cfg.edit_window_secs > 0 &&
      (Date.now() - target[0]!.ts) / 1000 > cfg.edit_window_secs
    ) {
      return {
        ok: false,
        code: "WINDOW_EXPIRED",
        message: "edit window has expired",
      };
    }

    // Section top-level post: preview is server-derived and folded into the
    // stored body at create time (handleItemCreate's isSectionPost branch) - an
    // edit MUST re-fold it the same way, or list/post reads keep the stale preview.
    const roomKind = roomRef.split("/")[1];
    const isSectionPost = roomKind === "sec" && target[0]!.parent_seq == null;
    const b = body as Record<string, unknown>;
    if ("topics" in b)
      return {
        ok: false,
        code: "OMEW_MALFORMED",
        message: "topics are no longer supported",
      };
    const finalBody: unknown =
      isSectionPost && typeof b.text === "string"
        ? { ...b, preview: markdownPreview(b.text, PREVIEW_LEN) }
        : b;

    const editedAt = Date.now();
    const searchOverlayPending =
      archivedTarget ||
      this.isInArchiveBatch(targetSeq) ||
      this.isSearchIndexedPost(target[0]!);
    const seq = this.allocateSeq();
    const bodyJson = JSON.stringify(finalBody);
    this.ctx.storage.sql.exec(
      "INSERT INTO edit (target_seq, seq, body, edited_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(target_seq) DO UPDATE SET seq = excluded.seq, body = excluded.body, edited_at = excluded.edited_at",
      targetSeq,
      seq,
      bodyJson,
      editedAt,
    );
    if (searchOverlayPending) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO archive_search_pending (target_seq) VALUES (?)",
        targetSeq,
      );
      this.ctx.waitUntil(this.repairArchiveSearch().catch(() => {}));
    }

    const editedFrame = {
      type: "item.update",
      seq,
      target_seq: targetSeq,
      body: finalBody,
      edited_at: editedAt,
    };
    const envelope = await this.appendSignedEvent(roomRef, actor, editedFrame);
    this.enqueueBroadcast(excludeWs, { ...editedFrame, envelope });
    this.reportTip(roomRef, seq);
    return { ok: true, seq };
  }

  // Author self-retract: gated the same way as edit (allow_message_retract +
  // edit_window_secs). owner/mod retracting someone else's item is moderation, not
  // self-service - it bypasses both the switch and the window, but a mod (not
  // owner) MUST NOT remove the owner's item.
  private async performRetract(
    actor: string,
    role: Role,
    roomRef: string,
    targetSeq: number,
    reason: string | undefined,
    excludeWs: WebSocket | null,
  ): Promise<RetractOutcome> {
    const alreadyTombstoned = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq)
      .toArray();
    if (alreadyTombstoned.length > 0) {
      return { ok: true, seq: null };
    }

    let target = this.ctx.storage.sql
      .exec<ItemRow>("SELECT * FROM item WHERE seq = ?", targetSeq)
      .toArray();
    let archivedTarget = false;
    if (target.length === 0) {
      const archived = await this.findArchivedItem(targetSeq);
      if (archived) {
        target = [archived];
        archivedTarget = true;
      }
    }
    if (target.length === 0) {
      return {
        ok: false,
        code: "OMEW_TARGET_NOT_FOUND",
        message: "target not found",
      };
    }

    const isAuthor = target[0]!.actor === actor;
    const isModerator = role === "mod" || role === "owner";
    if (!isAuthor && !isModerator) {
      return {
        ok: false,
        code: "OMEW_FORBIDDEN",
        message: "not author or moderator",
      };
    }

    const strongholdId = roomRef.split("/")[0]!;
    if (isAuthor) {
      const cfg = await this.ensureEditConfig(strongholdId);
      if (!cfg.allow_message_retract) {
        return {
          ok: false,
          code: "RETRACT_DISABLED",
          message: "message retraction is disabled for this stronghold",
        };
      }
      if (
        cfg.edit_window_secs > 0 &&
        (Date.now() - target[0]!.ts) / 1000 > cfg.edit_window_secs
      ) {
        return {
          ok: false,
          code: "WINDOW_EXPIRED",
          message: "retract window has expired",
        };
      }
    } else if (role === "mod") {
      const stub = this.env.STRONGHOLD_DO.getByName(strongholdId);
      const authorMember = await stub.getMember(target[0]!.actor);
      if (authorMember && authorMember.role === "owner") {
        return {
          ok: false,
          code: "OMEW_FORBIDDEN",
          message: "mod cannot delete the owner's item",
        };
      }
    }
    const byRole: "author" | "mod" | "owner" = isAuthor
      ? "author"
      : (role as "mod" | "owner");

    const ts = Date.now();
    const searchOverlayPending =
      archivedTarget ||
      this.isInArchiveBatch(targetSeq) ||
      this.isSearchIndexedPost(target[0]!);
    const seq = this.allocateSeq();
    this.ctx.storage.sql.exec(
      "INSERT INTO tombstone (seq, actor, ts, reason) VALUES (?, ?, ?, ?)",
      targetSeq,
      actor,
      ts,
      reason ?? null,
    );
    if (searchOverlayPending) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO archive_search_pending (target_seq) VALUES (?)",
        targetSeq,
      );
      this.ctx.waitUntil(this.repairArchiveSearch().catch(() => {}));
    }

    const deletedFrame = {
      type: "item.delete",
      seq,
      target_seq: targetSeq,
      reason,
      by_role: byRole,
    };
    const envelope = await this.appendSignedEvent(roomRef, actor, deletedFrame);
    this.enqueueBroadcast(excludeWs, { ...deletedFrame, envelope });
    this.reportTip(roomRef, seq);
    return { ok: true, seq };
  }

  private normalizedBody(body: unknown): JsonObject {
    const json = JSON.stringify(this.cleanSigned(body));
    if (new TextEncoder().encode(json).length > 50_000)
      throw new ProtocolError(400, "OMEW_MALFORMED");
    return strictJson(json) as JsonObject;
  }

  private cleanSigned(value: unknown): unknown {
    if (Array.isArray(value))
      return value
        .filter((entry) => entry !== null && entry !== undefined)
        .map((entry) => this.cleanSigned(entry));
    if (object(value))
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== null && entry !== undefined)
          .map(([key, entry]) => [key, this.cleanSigned(entry)]),
      );
    return typeof value === "string" ? value.normalize("NFC") : value;
  }

  private async scheduleFederationAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > Date.now() + 1000)
      await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private async appendSignedEvent(
    room: string,
    actor: string | null,
    frame: Record<string, unknown>,
  ): Promise<Envelope> {
    const seq = typeof frame.seq === "number" ? frame.seq : null;
    if (
      !this.ctx.storage.sql
        .exec("SELECT key FROM federation_state WHERE key='baseline'")
        .toArray().length
    ) {
      this.ctx.storage.sql.exec(
        "INSERT INTO federation_state(key,value) VALUES ('baseline',?)",
        String(seq ? seq - 1 : this.latestSequence()),
      );
    }
    const { type, seq: _seq, actor: _actor, ts: _ts, ...payload } = frame;
    const clean = this.cleanSigned({
      ...payload,
      ...(type === "item.create" && typeof frame.ts === "number"
        ? { created_at: frame.ts }
        : {}),
    }) as JsonObject;
    const id = uuidV7();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO local_event(id,seq,room,actor,frame,created_at) VALUES (?,?,?,?,?,?)",
      id,
      seq,
      room,
      actor,
      JSON.stringify({
        type,
        payload: clean,
        audience:
          this.ctx.storage.sql
            .exec<{
              value: string;
            }>("SELECT value FROM meta WHERE key='federation_visibility'")
            .toArray()[0]?.value === "private" ||
          Number(
            frame.target_seq ?? frame.root_seq ?? frame.post_seq ?? seq ?? 0,
          ) < this.publicHistoryFloor()
            ? "members"
            : "public",
      }),
      Date.now(),
    );
    const row =
      seq === null
        ? this.ctx.storage.sql
            .exec<{ id: string }>("SELECT id FROM local_event WHERE id=?", id)
            .one()
        : this.ctx.storage.sql
            .exec<{ id: string }>("SELECT id FROM local_event WHERE seq=?", seq)
            .one();
    await this.scheduleFederationAlarm();
    return this.signLocalEvent(row.id);
  }

  private async signLocalEvent(id: string): Promise<Envelope> {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        seq: number | null;
        room: string;
        actor: string | null;
        frame: string;
        envelope: string | null;
      }>("SELECT * FROM local_event WHERE id=?", id)
      .one();
    if (row.envelope) return JSON.parse(row.envelope) as Envelope;
    const frame = JSON.parse(row.frame) as {
      type: string;
      payload: JsonObject;
      audience: "public" | "members";
    };
    const event = await newEvent(this.env, frame.type, frame.payload, {
      id: row.id,
      audience: frame.audience,
      room: row.room,
      ...(row.actor ? { actor: row.actor } : {}),
      ...(row.seq !== null ? { seq: row.seq } : {}),
    });
    this.ctx.storage.sql.exec(
      "UPDATE local_event SET envelope=? WHERE id=?",
      JSON.stringify(event),
      id,
    );
    return event;
  }

  private latestSequence(): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>("SELECT value FROM meta WHERE key='next_seq'")
        .one().value - 1
    );
  }

  async registerSubscription(peer: string, expiresAt: number): Promise<number> {
    this.ctx.storage.sql.exec(
      "INSERT INTO subscription(peer,expires_at) VALUES (?,?) ON CONFLICT(peer) DO UPDATE SET expires_at=excluded.expires_at",
      peer,
      expiresAt,
    );
    return this.latestSequence();
  }

  async removeSubscription(peer: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM subscription WHERE peer=?", peer);
  }

  async runFederationAlarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        room: string;
      }>(
        "SELECT id,room FROM local_event WHERE delivered=0 ORDER BY created_at LIMIT 50",
      )
      .toArray();
    for (const row of rows) {
      const event = await this.signLocalEvent(row.id);
      const [id, , resId] = row.room.split("/");
      const stronghold = this.env.STRONGHOLD_DO.getByName(id!);
      const [config, room] = await Promise.all([
        stronghold.getConfig(),
        stronghold.getRoom(resId!),
      ]);
      if (
        event.type !== "item.reaction" &&
        config?.visibility === "public" &&
        room &&
        !room.restricted &&
        !room.archived
      ) {
        const peers = this.ctx.storage.sql
          .exec<{
            peer: string;
          }>("SELECT peer FROM subscription WHERE expires_at>?", Date.now())
          .toArray();
        const publicEvent = await this.publicEnvelope(event);
        if (publicEvent)
          for (const peer of peers)
            await queueDelivery(this.env, peer.peer, publicEvent);
      }
      this.ctx.storage.sql.exec(
        "UPDATE local_event SET delivered=1 WHERE id=?",
        row.id,
      );
    }
    await this.archiveSignedEvents();
    if (
      this.ctx.storage.sql
        .exec("SELECT id FROM local_event WHERE delivered=0 LIMIT 1")
        .toArray().length
    )
      await this.scheduleFederationAlarm();
    this.ctx.storage.sql.exec(
      "DELETE FROM local_event WHERE seq IS NULL AND delivered=1 AND created_at<?",
      Date.now() - 86400000,
    );
  }

  private async archiveSignedEvents(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{
        seq: number;
        room: string;
        envelope: string;
      }>(
        "SELECT seq,room,envelope FROM local_event WHERE seq IS NOT NULL AND delivered=1 AND envelope IS NOT NULL AND seq<? ORDER BY seq LIMIT 100",
        this.latestSequence() - 1000,
      )
      .toArray();
    if (!rows.length) return;
    const start = rows[0]!.seq;
    const end = rows.at(-1)!.seq;
    const key = `signed-events/${rows[0]!.room}/${start}-${end}.json.gz`;
    const stream = new Blob([
      JSON.stringify(rows.map((row) => JSON.parse(row.envelope))),
    ])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    await this.env.MEDIA.put(key, stream, {
      httpMetadata: {
        contentType: "application/json",
        contentEncoding: "gzip",
      },
    });
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO signed_event_archive(seq_start,seq_end,r2_key) VALUES (?,?,?)",
        start,
        end,
        key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM local_event WHERE seq>=? AND seq<=? AND delivered=1",
        start,
        end,
      );
    });
  }

  async getFederationHistory(
    room: string,
    after: number,
    before: number | null,
    limit: number,
    snapshotBefore: number | null = null,
  ): Promise<JsonObject> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO federation_state(key,value) VALUES ('baseline',?)",
      String(this.latestSequence()),
    );
    const baseline = Number(
      this.ctx.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM federation_state WHERE key='baseline'")
        .toArray()[0]?.value ?? this.latestSequence(),
    );
    const rows = this.ctx.storage.sql
      .exec<{
        envelope: string | null;
      }>(
        "SELECT envelope FROM local_event WHERE seq>? AND seq<? ORDER BY seq LIMIT ?",
        Math.max(after, baseline),
        before ?? Number.MAX_SAFE_INTEGER,
        limit,
      )
      .toArray();
    const events: Envelope[] = rows
      .filter((row) => row.envelope)
      .map((row) => JSON.parse(row.envelope!) as Envelope);
    const archives = this.ctx.storage.sql
      .exec<{
        r2_key: string;
      }>(
        "SELECT r2_key FROM signed_event_archive WHERE seq_end>? AND seq_start<? ORDER BY seq_start LIMIT 4",
        after,
        before ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray();
    for (const archive of archives) {
      const stored = await this.env.MEDIA.get(archive.r2_key);
      if (!stored?.body) throw new ProtocolError(503, "OMEW_SEQ_GAP");
      const body = (await new Response(
        stored.body.pipeThrough(new DecompressionStream("gzip")),
      ).json()) as Envelope[];
      events.push(
        ...body.filter(
          (event) =>
            event.seq! > after && (before === null || event.seq! < before),
        ),
      );
    }
    const selected: Envelope[] = [];
    for (const event of events
      .sort((a, b) => a.seq! - b.seq!)
      .slice(0, limit)) {
      const visible = await this.publicEnvelope(event);
      if (visible) selected.push(visible);
    }
    const snapshot =
      after < baseline
        ? await this.getHistory(
            Math.min(snapshotBefore ?? baseline + 1, baseline + 1),
            16,
          )
        : null;
    const snapshotItems = snapshot
      ? (this.cleanSigned(snapshot.items) as JsonObject[])
      : null;
    let snapshotCursor = snapshot?.next_before ?? null;
    const encoder = new TextEncoder();
    const sizeOf = (value: unknown) =>
      encoder.encode(JSON.stringify(value)).length + 1;
    const eventSizes = selected.map(sizeOf);
    const snapshotSizes = snapshotItems?.map(sizeOf) ?? [];
    let bytes =
      1000 +
      eventSizes.reduce((sum, size) => sum + size, 0) +
      snapshotSizes.reduce((sum, size) => sum + size, 0);
    while (bytes > 900_000 && selected.length > 0) {
      selected.pop();
      bytes -= eventSizes.pop()!;
    }
    while (bytes > 900_000 && snapshotItems && snapshotItems.length > 1) {
      snapshotItems.pop();
      bytes -= snapshotSizes.pop()!;
      snapshotCursor = Number(snapshotItems.at(-1)!.seq);
    }
    if (bytes > 900_000)
      throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
    return {
      room,
      origin: instanceDomain(this.env),
      latest_seq: this.latestSequence(),
      baseline,
      events: selected,
      ...(snapshot
        ? {
            snapshot: snapshotItems!,
            ...(snapshotCursor !== null
              ? { snapshot_next_before: snapshotCursor }
              : {}),
          }
        : {}),
    };
  }

  // S4.4: RoomDO -> StrongholdDO after each commit; fire-and-forget, never blocks
  // the ack/broadcast path. StrongholdDO persists before its own coalesced flush.
  private reportTip(roomRef: string, seq: number): void {
    const strongholdId = roomRef.split("/")[0]!;
    const stub = this.env.STRONGHOLD_DO.getByName(strongholdId);
    this.ctx.waitUntil(stub.reportTip(roomRef, seq).catch(() => {}));
  }

  // S5.3 resync: gap <= 500 replays directly, larger gaps defer to the history API.
  private async handleResync(
    ws: WebSocket,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const fromSeq = Number(frame.from_seq);
    if (!Number.isFinite(fromSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad resync");
      return;
    }
    const nextSeq = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'next_seq'")
      .one().value;
    const currentMax = nextSeq - 1;
    const gap = currentMax - fromSeq;
    if (gap <= 0) return;

    if (gap > RESYNC_GAP_LIMIT) {
      try {
        ws.send(
          JSON.stringify({
            type: "resync_gap",
            gap: true,
            from: fromSeq,
            to: currentMax,
          }),
        );
      } catch {
        // socket already gone; nothing to clean up.
      }
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<
        ItemRow & {
          edit_body: string | null;
          edited_at: number | null;
          tomb_seq: number | null;
        }
      >(
        `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
         FROM item i
         LEFT JOIN edit e ON e.target_seq = i.seq
         LEFT JOIN tombstone t ON t.seq = i.seq
         WHERE i.seq > ? ORDER BY i.seq ASC`,
        fromSeq,
      )
      .toArray();

    const requester =
      (ws.deserializeAttachment() as Attachment | null)?.actor ?? null;
    const floor = await this.viewerHistoryFloor(requester);
    const items = rows
      .filter((r) => r.tomb_seq == null && (r.root_seq ?? r.seq) >= floor)
      .map((r) => ({
        type: "item.create" as const,
        seq: r.seq,
        parent_seq: r.parent_seq,
        root_seq: r.root_seq,
        actor: r.actor,
        kind: r.kind,
        ts: r.ts,
        body: withoutTopics(JSON.parse(r.edit_body ?? r.body)),
      }));
    const snapshot = this.attachReactions(items, (i) => i.seq, requester);
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 50_000) {
      ws.send(
        JSON.stringify({
          type: "resync_gap",
          gap: true,
          from: fromSeq,
          to: currentMax,
        }),
      );
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const envelope = await newEvent(
      this.env,
      "room.snapshot",
      this.cleanSigned({ items: snapshot }) as JsonObject,
      { room: attachment?.room, audience: "members" },
    );
    try {
      ws.send(JSON.stringify({ type: "batch", items: snapshot, envelope }));
    } catch {
      // socket already gone.
    }
  }

  // ---- reactions (m0-protocol §3.2a) -----------------------------------------
  // Absolute {entries, mine} attached to every read-path item/post. entries is
  // the full per-name count (never a delta, same idempotent-snapshot philosophy
  // as item.bump); mine is the requester's own reaction names, empty for guests
  // or when no requester identity is available. Batched IN(...) lookups so a
  // 200-row history page or post list costs two extra queries total, not 2*N.
  private attachReactions<T>(
    rows: T[],
    seqOf: (row: T) => number,
    actor: string | null,
  ): (T & {
    reactions: { entries: { name: string; count: number }[]; mine: string[] };
  })[] {
    if (rows.length === 0) return [];
    const seqs = rows.map(seqOf);
    const placeholders = seqs.map(() => "?").join(",");

    const entryRows = this.ctx.storage.sql
      .exec<{
        target_seq: number;
        name: string;
        count: number;
      }>(
        `SELECT target_seq, name, COUNT(*) AS count FROM reaction WHERE target_seq IN (${placeholders}) GROUP BY target_seq, name ORDER BY name`,
        ...seqs,
      )
      .toArray();
    const entriesBySeq = new Map<number, { name: string; count: number }[]>();
    for (const r of entryRows) {
      const list = entriesBySeq.get(r.target_seq) ?? [];
      list.push({ name: r.name, count: r.count });
      entriesBySeq.set(r.target_seq, list);
    }

    const mineBySeq = new Map<number, string[]>();
    if (actor) {
      const mineRows = this.ctx.storage.sql
        .exec<{
          target_seq: number;
          name: string;
        }>(
          `SELECT target_seq, name FROM reaction WHERE actor = ? AND target_seq IN (${placeholders})`,
          actor,
          ...seqs,
        )
        .toArray();
      for (const r of mineRows) {
        const list = mineBySeq.get(r.target_seq) ?? [];
        list.push(r.name);
        mineBySeq.set(r.target_seq, list);
      }
    }

    return rows.map((row) => {
      const seq = seqOf(row);
      return {
        ...row,
        reactions: {
          entries: entriesBySeq.get(seq) ?? [],
          mine: mineBySeq.get(seq) ?? [],
        },
      };
    });
  }

  // ---- ack / batch broadcast -------------------------------------------------

  private sendAck(ws: WebSocket, ack: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify({ type: "ack", ...ack }));
    } catch {
      // socket already gone; the client will resend on reconnect.
      return;
    }
    if (typeof ack.seq === "number") {
      this.bumpLastSeq(ws, ack.seq);
    }
  }

  private sendError(
    ws: WebSocket,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    try {
      ws.send(JSON.stringify({ type: "error", code, message, ...extra }));
    } catch {
      // ignore.
    }
  }

  private bumpLastSeq(ws: WebSocket, seq: number): void {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    if (seq > attachment.last_seq) {
      attachment.last_seq = seq;
      ws.serializeAttachment(attachment);
    }
  }

  // S4.3/S5.2: commit already happened by the time this is called; ack was already
  // sent synchronously above. This only queues the fan-out to everyone else, batched
  // in a window that exists solely while there is something pending to flush.
  // senderWs is null for HTTP-originated writes (edit/retract endpoints) -
  // there is no sender connection to exclude, every connected socket gets the frame.
  private enqueueBroadcast(
    senderWs: WebSocket | null,
    frame: Record<string, unknown>,
  ): void {
    this.pendingBatch.push({ senderWs, frame });
    if (this.batchTimer == null) {
      this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_WINDOW_MS);
    }
  }

  private flushBatch(): void {
    this.batchTimer = null;
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch;
    this.pendingBatch = [];

    for (const ws of this.ctx.getWebSockets()) {
      const floor = this.socketHistoryFloor(
        ws.deserializeAttachment() as Attachment | null,
      );
      const frames = batch
        .filter(
          (e) =>
            e.senderWs !== ws &&
            Number(
              e.frame.target_seq ??
                e.frame.root_seq ??
                e.frame.post_seq ??
                e.frame.seq ??
                0,
            ) >= floor,
        )
        .map((e) => e.frame);
      if (frames.length === 0) continue;
      try {
        ws.send(JSON.stringify({ type: "batch", items: frames }));
      } catch {
        continue;
      }
      const maxSeq = frames.reduce((max, f) => {
        const seq = f.seq;
        return typeof seq === "number" && seq > max ? seq : max;
      }, -1);
      if (maxSeq >= 0) this.bumpLastSeq(ws, maxSeq);
    }
  }

  // ---- bump throttle (proposal S4.5) -----------------------------------------
  // Trailing throttle per post_seq: at most one broadcast every BUMP_THROTTLE_MS.
  // The flush always reads fresh state off post_index/item, so it's an absolute
  // snapshot (LWW) regardless of how many replies coalesced into it - never an
  // accumulated delta.

  private scheduleBump(postSeq: number): void {
    if (this.bumpTimers.has(postSeq)) return; // already queued, will pick up latest state when it fires
    const last = this.lastBumpAt.get(postSeq) ?? 0;
    const delay = Math.max(0, BUMP_THROTTLE_MS - (Date.now() - last));
    const timer = setTimeout(
      () => this.ctx.waitUntil(this.flushBump(postSeq)),
      delay,
    );
    this.bumpTimers.set(postSeq, timer);
  }

  private async flushBump(postSeq: number): Promise<void> {
    this.bumpTimers.delete(postSeq);
    const tomb = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM tombstone WHERE seq = ?", postSeq)
      .toArray();
    if (tomb.length > 0) return; // post retracted meanwhile - nothing to bump.
    const idx = this.ctx.storage.sql
      .exec<{
        last_reply_seq: number;
        reply_count: number;
        bumped_at: number;
      }>(
        "SELECT last_reply_seq, reply_count, bumped_at FROM post_index WHERE post_seq = ?",
        postSeq,
      )
      .toArray()[0];
    if (!idx) return;
    const post = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM item WHERE seq = ?", postSeq)
      .toArray()[0];
    let preview = "";
    if (post) {
      try {
        preview = (JSON.parse(post.body) as { preview?: string }).preview ?? "";
      } catch {
        // malformed stored body should never happen; drop preview rather than throw.
      }
    }
    this.lastBumpAt.set(postSeq, Date.now());
    const frame = {
      type: "item.bump",
      post_seq: postSeq,
      last_reply_seq: idx.last_reply_seq,
      reply_count: idx.reply_count,
      preview,
      ts: idx.bumped_at,
    };
    const room = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key='room_ref'")
      .toArray()[0]?.value;
    if (!room) return;
    const envelope = await this.appendSignedEvent(room, null, frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const floor = this.socketHistoryFloor(
          ws.deserializeAttachment() as Attachment | null,
        );
        if (postSeq < floor) continue;
        ws.send(JSON.stringify({ ...frame, envelope }));
      } catch {
        continue;
      }
    }
  }

  // S9: token bucket per actor, not per connection.
  private takeRateToken(actor: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(actor) ?? {
      tokens: RATE_LIMIT_CAPACITY,
      last: now,
    };
    const elapsedSec = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(
      RATE_LIMIT_CAPACITY,
      bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC,
    );
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.rateBuckets.set(actor, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.rateBuckets.set(actor, bucket);
    return true;
  }

  private scheduleArchiveAlarm(): void {
    this.ctx.waitUntil(
      (async () => {
        if (!(await this.ctx.storage.getAlarm()))
          await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_ALARM_MS);
      })().catch(() => {}),
    );
  }

  // ---- history RPC ------------------------------------------------------------

  // S5.3: pagination is seq-anchored, never timestamp-anchored.
  async getHistory(
    beforeSeq: number | null,
    limit: number,
    actor: string | null = null,
  ): Promise<{
    items: unknown[];
    next_before: number | null;
    has_more: boolean;
  }> {
    const floor = await this.viewerHistoryFloor(actor);
    const cappedLimit = Math.max(
      1,
      Math.min(limit || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
    );
    const rows =
      beforeSeq == null
        ? this.ctx.storage.sql
            .exec<
              ItemRow & {
                edit_body: string | null;
                edited_at: number | null;
                tomb_seq: number | null;
              }
            >(
              `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
             FROM item i
             LEFT JOIN edit e ON e.target_seq = i.seq
             LEFT JOIN tombstone t ON t.seq = i.seq
             WHERE t.seq IS NULL ORDER BY i.seq DESC LIMIT ?`,
              cappedLimit,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<
              ItemRow & {
                edit_body: string | null;
                edited_at: number | null;
                tomb_seq: number | null;
              }
            >(
              `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
             FROM item i
             LEFT JOIN edit e ON e.target_seq = i.seq
             LEFT JOIN tombstone t ON t.seq = i.seq
             WHERE i.seq < ? AND t.seq IS NULL ORDER BY i.seq DESC LIMIT ?`,
              beforeSeq,
              cappedLimit,
            )
            .toArray();

    const hotItems = rows
      .filter((r) => r.tomb_seq == null)
      .map((r) => ({
        seq: r.seq,
        parent_seq: r.parent_seq,
        root_seq: r.root_seq,
        actor: r.actor,
        kind: r.kind,
        ts: r.ts,
        body: withoutTopics(JSON.parse(r.edit_body ?? r.body)),
        edited_at: r.edited_at ?? undefined,
      }));
    const archivedPage = await this.getArchivedHistory(
      beforeSeq,
      Math.max(0, cappedLimit - hotItems.length),
    );
    const archivedItems = archivedPage.items;
    const bySeq = new Map<number, (typeof hotItems)[number]>();
    for (const item of archivedItems)
      bySeq.set(item.seq, item as (typeof hotItems)[number]);
    for (const item of hotItems) bySeq.set(item.seq, item);
    const merged = [...bySeq.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, cappedLimit);
    const hotScanned = this.ctx.storage.sql
      .exec<{
        seq: number;
      }>(
        `SELECT seq FROM item WHERE (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
        beforeSeq,
        beforeSeq,
        cappedLimit,
      )
      .toArray();
    const scanCandidates = [
      ...hotScanned.map((row) => row.seq),
      ...(archivedPage.scannedBefore == null
        ? []
        : [archivedPage.scannedBefore]),
    ];
    const nextBefore = scanCandidates.length
      ? Math.min(...scanCandidates)
      : null;
    const roomRef = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    const hasOlderArchive =
      nextBefore != null &&
      !!roomRef &&
      !!(await this.env.DB.prepare(
        "SELECT 1 AS found FROM archive_index WHERE do_key = ? AND seq_start < ? LIMIT 1",
      )
        .bind(roomRef, nextBefore)
        .first());
    const hasMore =
      archivedPage.hasMore ||
      hasOlderArchive ||
      (nextBefore != null &&
        !!this.ctx.storage.sql
          .exec<{
            seq: number;
          }>("SELECT seq FROM item WHERE seq < ? LIMIT 1", nextBefore)
          .toArray()[0]);
    return {
      items: await this.attachReactions(
        merged.filter((item) => (item.root_seq ?? item.seq) >= floor),
        (i) => i.seq,
        actor,
      ),
      next_before:
        hasMore && nextBefore !== null && nextBefore > floor
          ? nextBefore
          : null,
      has_more: hasMore && nextBefore !== null && nextBefore > floor,
    };
  }

  private async getArchivedHistory(
    beforeSeq: number | null,
    limit: number,
    rootSeq?: number,
  ): Promise<{
    items: {
      seq: number;
      parent_seq: number | null;
      root_seq: number | null;
      actor: string;
      kind: string;
      ts: number;
      body: unknown;
      edited_at?: number;
    }[];
    scannedBefore: number | null;
    hasMore: boolean;
  }> {
    if (limit <= 0) return { items: [], scannedBefore: null, hasMore: false };
    const doKey = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (!doKey) return { items: [], scannedBefore: null, hasMore: false };
    const indexes = await this.env.DB.prepare(
      "SELECT seq_start, seq_end, r2_key FROM archive_index WHERE do_key = ? AND (? IS NULL OR seq_start < ?) ORDER BY seq_end DESC",
    )
      .bind(doKey, beforeSeq, beforeSeq)
      .all<{ seq_start: number; seq_end: number; r2_key: string }>();
    const output: {
      seq: number;
      parent_seq: number | null;
      root_seq: number | null;
      actor: string;
      kind: string;
      ts: number;
      body: unknown;
      edited_at?: number;
    }[] = [];
    let scannedBefore: number | null = null;
    let hasMore = false;
    const appendBatch = (batch: ArchiveItem[]): boolean => {
      const sideRows = this.ctx.storage.sql
        .exec<{
          target_seq: number;
          edit_body: string | null;
          edited_at: number | null;
          tomb_seq: number | null;
        }>(
          `SELECT i.seq AS target_seq, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
         FROM (SELECT ? AS seq ${batch
           .slice(1)
           .map(() => "UNION ALL SELECT ? AS seq")
           .join(" ")}) i
         LEFT JOIN edit e ON e.target_seq = i.seq LEFT JOIN tombstone t ON t.seq = i.seq`,
          ...batch.map((row) => row.seq),
        )
        .toArray();
      const sideBySeq = new Map(sideRows.map((row) => [row.target_seq, row]));
      for (const row of batch) {
        if (output.length >= limit) {
          hasMore = true;
          return false;
        }
        scannedBefore =
          scannedBefore == null ? row.seq : Math.min(scannedBefore, row.seq);
        const side = sideBySeq.get(row.seq);
        if (side?.tomb_seq != null) continue;
        output.push({
          seq: row.seq,
          parent_seq: row.parent_seq,
          root_seq: row.root_seq,
          actor: row.actor,
          kind: row.kind,
          ts: row.ts,
          body: withoutTopics(JSON.parse(side?.edit_body ?? row.body)),
          edited_at: side?.edited_at ?? undefined,
        });
      }
      return true;
    };
    for (const shard of indexes.results) {
      if (hasMore) break;
      const object = await this.env.MEDIA.get(shard.r2_key);
      if (!object?.body) continue;
      let batch: ArchiveItem[] = [];
      await readGzipRecordsUntil(object.body, (record) => {
        if (
          record.type !== "item" ||
          (beforeSeq != null && record.row.seq >= beforeSeq) ||
          (rootSeq != null && record.row.root_seq !== rootSeq)
        )
          return true;
        batch.push(record.row);
        if (batch.length < 400) return true;
        const continueReading = appendBatch(batch);
        batch = [];
        return continueReading;
      });
      if (batch.length && output.length < limit) appendBatch(batch);
    }
    output.sort((a, b) => b.seq - a.seq);
    output.splice(limit);
    return { items: output, scannedBefore, hasMore };
  }

  private async findArchivedItem(
    targetSeq: number,
  ): Promise<ArchiveItem | null> {
    const doKey = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (!doKey) return null;
    const shard = await this.env.DB.prepare(
      "SELECT r2_key FROM archive_index WHERE do_key = ? AND seq_start <= ? AND seq_end >= ? ORDER BY seq_start DESC LIMIT 1",
    )
      .bind(doKey, targetSeq, targetSeq)
      .first<{ r2_key: string }>();
    if (!shard) return null;
    const object = await this.env.MEDIA.get(shard.r2_key);
    if (!object?.body) return null;
    let found: ArchiveItem | null = null;
    await readGzipRecordsUntil(object.body, (record) => {
      if (record.type !== "item" || record.row.seq !== targetSeq) return true;
      found = record.row;
      return false;
    });
    return found;
  }

  private async repairArchiveSearch(): Promise<number> {
    const doKey = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room_ref'")
      .toArray()[0]?.value;
    if (!doKey) return 0;
    const pending = this.ctx.storage.sql
      .exec<{
        target_seq: number;
      }>(
        "SELECT target_seq FROM archive_search_pending ORDER BY target_seq LIMIT 100",
      )
      .toArray();
    let repaired = 0;
    for (const { target_seq: targetSeq } of pending) {
      const hotRow = this.ctx.storage.sql
        .exec<ArchiveItem>(
          "SELECT seq, parent_seq, root_seq, actor, origin, client_id, kind, ts, body FROM item WHERE seq = ?",
          targetSeq,
        )
        .toArray()[0];
      const itemRow = hotRow ?? (await this.findArchivedItem(targetSeq));
      if (!itemRow) continue;
      const side = this.ctx.storage.sql
        .exec<{
          body: string | null;
          tomb_seq: number | null;
        }>(
          "SELECT e.body, t.seq AS tomb_seq FROM (SELECT ? AS seq) item LEFT JOIN edit e ON e.target_seq = item.seq LEFT JOIN tombstone t ON t.seq = item.seq",
          targetSeq,
        )
        .one();
      const prior = await this.env.DB.prepare(
        "SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq = ?",
      )
        .bind(doKey, String(targetSeq))
        .first<{
          rowid: number;
          do_key: string;
          seq: string;
          text: string;
          actor: string;
          ts: string;
          kind: string;
          root_seq: string;
        }>();
      const statements = [];
      if (prior) {
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO archive_search(archive_search, rowid, do_key, seq, text, actor, ts, kind, root_seq) VALUES ('delete', ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            prior.rowid,
            prior.do_key,
            prior.seq,
            prior.text,
            prior.actor,
            prior.ts,
            prior.kind,
            prior.root_seq,
          ),
        );
      }
      if (side.tomb_seq != null) {
        if (prior)
          statements.push(
            this.env.DB.prepare(
              "DELETE FROM archive_document WHERE rowid = ?",
            ).bind(prior.rowid),
          );
      } else if (prior) {
        statements.push(
          this.env.DB.prepare(
            "UPDATE archive_document SET text = ? WHERE rowid = ?",
          ).bind(searchableText(side.body ?? itemRow.body), prior.rowid),
        );
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO archive_search(rowid, do_key, seq, text, actor, ts, kind, root_seq) " +
              "SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE rowid = ?",
          ).bind(prior.rowid),
        );
      } else {
        const text = searchableText(side.body ?? itemRow.body);
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO archive_document (do_key, seq, text, actor, ts, kind, root_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            doKey,
            String(targetSeq),
            text,
            itemRow.actor,
            String(itemRow.ts),
            itemRow.kind,
            itemRow.root_seq == null ? "" : String(itemRow.root_seq),
          ),
        );
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO archive_search(rowid, do_key, seq, text, actor, ts, kind, root_seq) " +
              "SELECT rowid, do_key, seq, text, actor, ts, kind, root_seq FROM archive_document WHERE do_key = ? AND seq = ?",
          ).bind(doKey, String(targetSeq)),
        );
      }
      if (statements.length) await this.env.DB.batch(statements);
      this.ctx.storage.sql.exec(
        "DELETE FROM archive_search_pending WHERE target_seq = ?",
        targetSeq,
      );
      repaired++;
    }
    return repaired;
  }

  async searchRecent(
    query: string,
    limit: number,
    actor: string | null = null,
  ): Promise<unknown[]> {
    const floor = await this.viewerHistoryFloor(actor);
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const rows = this.ctx.storage.sql
      .exec<
        ItemRow & {
          edit_body: string | null;
          edited_at: number | null;
          tomb_seq: number | null;
        }
      >(
        `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
       FROM item i LEFT JOIN edit e ON e.target_seq = i.seq LEFT JOIN tombstone t ON t.seq = i.seq
       WHERE i.ts >= ? ORDER BY i.seq DESC LIMIT 50000`,
        Date.now() - HOT_AGE_MS,
      )
      .toArray();
    const matches = rows
      .filter((row) => {
        if (row.tomb_seq != null || (row.root_seq ?? row.seq) < floor)
          return false;
        const body = searchableText(
          row.edit_body ?? row.body,
        ).toLocaleLowerCase();
        return terms.every((term) => body.includes(term));
      })
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((row) => ({
        seq: row.seq,
        parent_seq: row.parent_seq,
        root_seq: row.root_seq,
        actor: row.actor,
        kind: row.kind,
        ts: row.ts,
        body: withoutTopics(JSON.parse(row.edit_body ?? row.body)),
        edited_at: row.edited_at ?? undefined,
      }));
    return this.attachReactions(matches, (item) => item.seq, actor);
  }

  async applyArchiveSearchOverlays<
    T extends {
      seq: number;
      text: string;
      actor: string;
      ts: number;
      kind: string;
      root_seq: string | number;
    },
  >(matches: T[], query: string, actor: string | null = null): Promise<T[]> {
    const floor = await this.viewerHistoryFloor(actor);
    matches = matches.filter(
      (row) => (Number(row.root_seq) || row.seq) >= floor,
    );
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const output: T[] = [];
    for (let offset = 0; offset < matches.length; offset += 400) {
      const batch = matches.slice(offset, offset + 400);
      const sideRows = this.ctx.storage.sql
        .exec<{
          seq: number;
          edit_body: string | null;
          edited_at: number | null;
          tomb_seq: number | null;
        }>(
          `SELECT source.seq, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
         FROM (${batch.map(() => "SELECT ? AS seq").join(" UNION ALL ")}) source
         LEFT JOIN edit e ON e.target_seq = source.seq LEFT JOIN tombstone t ON t.seq = source.seq`,
          ...batch.map((row) => row.seq),
        )
        .toArray();
      const sides = new Map(sideRows.map((row) => [row.seq, row]));
      for (const match of batch) {
        const side = sides.get(match.seq);
        if (side?.tomb_seq != null) continue;
        const text = side?.edit_body
          ? searchableText(side.edit_body)
          : match.text;
        if (!terms.every((term) => text.toLocaleLowerCase().includes(term)))
          continue;
        output.push({ ...match, text } as T);
      }
    }
    return output;
  }

  // ---- section posts RPC (proposal S4.5) ---------------------------------------

  // Sorted by bumped_at desc (most recently active thread first), composite
  // (bumped_at, post_seq) cursor so a tie at the same millisecond still paginates
  // deterministically.
  async listPosts(
    after: string | null,
    limit?: number,
    actor: string | null = null,
  ): Promise<{ posts: unknown[]; next_cursor: string | null }> {
    const floor = await this.viewerHistoryFloor(actor);
    const cappedLimit = Math.max(
      1,
      Math.min(limit || POSTS_DEFAULT_LIMIT, POSTS_MAX_LIMIT),
    );
    let cursorBumpedAt = Number.MAX_SAFE_INTEGER;
    let cursorSeq = Number.MAX_SAFE_INTEGER;
    if (after) {
      const [atPart, seqPart] = after.split(":");
      const at = Number(atPart);
      const seq = Number(seqPart);
      if (Number.isFinite(at) && Number.isFinite(seq)) {
        cursorBumpedAt = at;
        cursorSeq = seq;
      }
    }

    let query = `SELECT p.post_seq, p.last_reply_seq, p.reply_count, p.bumped_at, i.actor, i.ts, i.body,
                        e.body AS edit_body, e.edited_at
                 FROM post_index p
                 JOIN item i ON i.seq = p.post_seq
                 LEFT JOIN edit e ON e.target_seq = p.post_seq`;
    query += ` LEFT JOIN tombstone t ON t.seq = p.post_seq
               WHERE t.seq IS NULL AND p.post_seq >= ? AND (p.bumped_at < ? OR (p.bumped_at = ? AND p.post_seq < ?))
               ORDER BY p.bumped_at DESC, p.post_seq DESC LIMIT ?`;
    const params: unknown[] = [
      floor,
      cursorBumpedAt,
      cursorBumpedAt,
      cursorSeq,
      cappedLimit + 1,
    ];

    const rows = this.ctx.storage.sql
      .exec<{
        post_seq: number;
        last_reply_seq: number;
        reply_count: number;
        bumped_at: number;
        actor: string;
        ts: number;
        body: string;
        edit_body: string | null;
        edited_at: number | null;
      }>(query, ...params)
      .toArray();

    const hasMore = rows.length > cappedLimit;
    const page = rows.slice(0, cappedLimit);
    const posts = page.map((r) => {
      const body = JSON.parse(r.edit_body ?? r.body) as {
        title?: string;
        cover?: string;
        preview?: string;
        media?: unknown;
      };
      return {
        post_seq: r.post_seq,
        actor: r.actor,
        created_at: r.ts,
        title: body.title ?? "",
        cover: body.cover ?? null,
        preview: body.preview ?? "",
        media: body.media ?? [],
        last_reply_seq: r.last_reply_seq,
        reply_count: r.reply_count,
        bumped_at: r.bumped_at,
        edited_at: r.edited_at ?? undefined,
      };
    });
    const last = page[page.length - 1];
    const next_cursor =
      hasMore && last ? `${last.bumped_at}:${last.post_seq}` : null;
    return {
      posts: this.attachReactions(posts, (p) => p.post_seq, actor),
      next_cursor,
    };
  }

  // section room post_count for the rooms list - a plain count, not
  // listPosts's full page (avoids pulling the whole post_index + item join).
  async countPosts(actor: string | null = null): Promise<number> {
    const floor = await this.viewerHistoryFloor(actor);
    return this.ctx.storage.sql
      .exec<{
        n: number;
      }>(
        "SELECT COUNT(*) AS n FROM post_index p LEFT JOIN tombstone t ON t.seq = p.post_seq WHERE t.seq IS NULL AND p.post_seq>=?",
        floor,
      )
      .one().n;
  }

  // Post detail + seq-anchored reply page (same before/limit idiom as getHistory).
  async getPost(
    postSeq: number,
    before: number | null,
    limit?: number,
    actor: string | null = null,
  ): Promise<{
    post: unknown;
    replies: unknown[];
    next_before: number | null;
  } | null> {
    if (postSeq < (await this.viewerHistoryFloor(actor))) return null;
    const postRows = this.ctx.storage.sql
      .exec<
        ItemRow & {
          tomb_seq: number | null;
          edit_body: string | null;
          edited_at: number | null;
        }
      >(
        `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
         FROM item i
         LEFT JOIN tombstone t ON t.seq = i.seq
         LEFT JOIN edit e ON e.target_seq = i.seq
         WHERE i.seq = ?`,
        postSeq,
      )
      .toArray();
    const postRow = postRows[0];
    if (
      !postRow ||
      postRow.tomb_seq != null ||
      postRow.kind !== "post" ||
      postRow.parent_seq != null
    ) {
      return null;
    }
    const idx = this.ctx.storage.sql
      .exec<{
        last_reply_seq: number;
        reply_count: number;
        bumped_at: number;
      }>(
        "SELECT last_reply_seq, reply_count, bumped_at FROM post_index WHERE post_seq = ?",
        postSeq,
      )
      .toArray()[0];
    const body = JSON.parse(postRow.edit_body ?? postRow.body) as {
      title?: string;
      text?: string;
      cover?: string;
      preview?: string;
      media?: unknown;
    };
    const post = {
      post_seq: postSeq,
      actor: postRow.actor,
      created_at: postRow.ts,
      title: body.title ?? "",
      text: body.text ?? "",
      cover: body.cover ?? null,
      preview: body.preview ?? "",
      media: body.media ?? [],
      last_reply_seq: idx?.last_reply_seq ?? postSeq,
      reply_count: idx?.reply_count ?? 0,
      bumped_at: idx?.bumped_at ?? postRow.ts,
      edited_at: postRow.edited_at ?? undefined,
    };

    const cappedLimit = Math.max(
      1,
      Math.min(limit || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
    );
    const replyRows =
      before == null
        ? this.ctx.storage.sql
            .exec<
              ItemRow & {
                tomb_seq: number | null;
                edit_body: string | null;
                edited_at: number | null;
              }
            >(
              `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
             FROM item i
             LEFT JOIN tombstone t ON t.seq = i.seq
             LEFT JOIN edit e ON e.target_seq = i.seq
             WHERE i.root_seq = ? AND i.parent_seq IS NOT NULL AND t.seq IS NULL ORDER BY i.seq DESC LIMIT ?`,
              postSeq,
              cappedLimit + 1,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<
              ItemRow & {
                tomb_seq: number | null;
                edit_body: string | null;
                edited_at: number | null;
              }
            >(
              `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
             FROM item i
             LEFT JOIN tombstone t ON t.seq = i.seq
             LEFT JOIN edit e ON e.target_seq = i.seq
             WHERE i.root_seq = ? AND i.parent_seq IS NOT NULL AND i.seq < ? AND t.seq IS NULL ORDER BY i.seq DESC LIMIT ?`,
              postSeq,
              before,
              cappedLimit + 1,
            )
            .toArray();

    const hotReplies = replyRows
      .filter((r) => r.tomb_seq == null)
      .map((r) => ({
        seq: r.seq,
        actor: r.actor,
        ts: r.ts,
        body: withoutTopics(JSON.parse(r.edit_body ?? r.body)),
        edited_at: r.edited_at ?? undefined,
      }));
    const coldReplies = (
      await this.getArchivedHistory(before, cappedLimit + 1, postSeq)
    ).items.map((r) => ({
      seq: r.seq,
      actor: r.actor,
      ts: r.ts,
      body: r.body,
      edited_at: r.edited_at,
    }));
    const repliesBySeq = new Map<number, (typeof hotReplies)[number]>();
    for (const reply of coldReplies)
      repliesBySeq.set(reply.seq, reply as (typeof hotReplies)[number]);
    for (const reply of hotReplies) repliesBySeq.set(reply.seq, reply);
    const mergedReplies = [...repliesBySeq.values()].sort(
      (a, b) => b.seq - a.seq,
    );
    const hasMoreReplies = mergedReplies.length > cappedLimit;
    const replies = mergedReplies.slice(0, cappedLimit);
    const lastReply = replies[replies.length - 1];
    const next_before = hasMoreReplies && lastReply ? lastReply.seq : null;
    return {
      post: this.attachReactions([post], (p) => p.post_seq, actor)[0],
      replies: this.attachReactions(replies, (r) => r.seq, actor),
      next_before,
    };
  }
}
