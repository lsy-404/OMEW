import { DurableObject } from "cloudflare:workers";
import { verifyToken } from "./auth";
import { getInstanceBranding } from "./config";
import { markdownPreview } from "./markdown-preview";
import { featurePaused, type EditConfigSnapshot, type FeatureRestrictionSnapshot, type MemberRevokePayload } from "./stronghold-do";
import {
  DENY_CHANNEL_SPEAK,
  DENY_SECTION_POST,
  DENY_SECTION_REPLY,
  instanceDomain,
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
export type EditOutcome = { ok: true; seq: number } | { ok: false; code: string; message: string };
export type RetractOutcome = { ok: true; seq: number | null } | { ok: false; code: string; message: string };

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
    ctx.blockConcurrencyWhile(async () => this.migrate());
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
    `);
    // 标签功能已移除；旧帖子标签索引不再保留。
    sql.exec("DROP TABLE IF EXISTS post_topic;");
    sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('next_seq', 1)`);
  }

  // S5.1/S5.2: next_seq lives only here, bumped atomically with the RETURNING trick
  // (single synchronous sql.exec, no await - coalesced with whatever write follows).
  private allocateSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "UPDATE meta SET value = value + 1 WHERE key = 'next_seq' RETURNING value - 1 AS seq"
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
      .exec<{ key: string; value: number }>(
        "SELECT key, value FROM meta WHERE key IN ('allow_message_edit', 'allow_message_retract', 'edit_window_secs')"
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
        key, value
      );
    }
  }

  // DO-to-DO push target, called by StrongholdDO.updateConfig.
  async setEditConfig(cfg: EditConfigSnapshot): Promise<void> {
    this.persistEditConfig(cfg);
  }

  private readFeatureRestrictions(): FeatureRestrictionSnapshot | null {
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key = 'feature_restrictions'"
    ).toArray();
    if (!rows[0]) return null;
    try {
      const value = JSON.parse(rows[0].value) as FeatureRestrictionSnapshot;
      return value?.chat && value?.posts ? value : null;
    } catch {
      return null;
    }
  }

  private persistFeatureRestrictions(snapshot: FeatureRestrictionSnapshot): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('feature_restrictions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(snapshot)
    );
  }

  async setFeatureRestrictions(snapshot: FeatureRestrictionSnapshot): Promise<void> {
    this.persistFeatureRestrictions(snapshot);
  }

  private async ensureFeatureRestrictions(strongholdId: string): Promise<FeatureRestrictionSnapshot> {
    const cached = this.readFeatureRestrictions();
    try {
      // Query back for every item.create. The durable snapshot remains the
      // fallback for a transient RPC outage, but cannot permanently conceal a
      // failed or newly-applied policy push from an old websocket.
      const fetched = await this.env.STRONGHOLD_DO.getByName(strongholdId).getFeatureRestrictions();
      if (fetched) {
        this.persistFeatureRestrictions(fetched);
        return fetched;
      }
    } catch {
      if (cached) return cached;
    }
    const snapshot = cached ?? {
      chat: { owner_paused: false, owner_expires_at: null, server_override: "inherit" as const, server_expires_at: null },
      posts: { owner_paused: false, owner_expires_at: null, server_override: "inherit" as const, server_expires_at: null },
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

  private async ensureEditConfig(strongholdId: string): Promise<EditConfigSnapshot> {
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
      : { allow_message_edit: true, allow_message_retract: true, edit_window_secs: 300 };
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
    const claims = await verifyToken<RoomTokenClaims>(token, this.env.DEV_TOKEN_SECRET);
    if (
      !claims ||
      claims.typ !== "room" ||
      !this.env.ROOM_DO.idFromName(claims.room).equals(this.ctx.id)
    ) {
      return new Response("invalid token", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      actor: claims.actor,
      origin: instanceDomain(this.env, new URL(request.url).hostname),
      room: claims.room,
      role: claims.role,
      deny: claims.deny,
      last_seq: 0,
    };
    server.serializeAttachment(attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": token },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
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
        this.handleItemCreate(ws, attachment, frame);
        return;
      case "item.update":
        this.handleItemUpdate(ws, attachment, frame);
        return;
      case "item.delete":
        this.handleItemDelete(ws, attachment, frame);
        return;
      case "item.reaction":
        this.handleItemReaction(ws, attachment, frame);
        return;
      case "resync":
        this.handleResync(ws, frame);
        return;
      default:
        // m0-protocol S13.2: unknown types are silently ignored, no error frame.
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
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

  private async handleItemCreate(ws: WebSocket, attachment: Attachment, frame: Record<string, unknown>): Promise<void> {
    const clientId = String(frame.client_id ?? "");
    const kind = String(frame.kind ?? "");
    const parentSeq = frame.parent_seq == null ? null : Number(frame.parent_seq);
    const body = frame.body;

    if (!clientId || clientId.length > 64) {
      this.sendError(ws, "OMEW_MALFORMED", "bad client_id");
      return;
    }
    if (kind !== "post" && kind !== "reply") {
      // m0-protocol S3.2: unknown kind is treated like unknown type - ignored, not an error.
      this.sendAck(ws, { status: "ignored", client_id: clientId, reason: "unknown_kind" });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.sendError(ws, "OMEW_MALFORMED", "body must be an object");
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
        this.sendError(ws, "OMEW_KIND_INVALID_FOR_ROOM", "channels only accept plain messages");
        return;
      }
    } else if (isTopLevel) {
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (kind !== "post" || !title || title.length > POST_TITLE_MAX || typeof b.text !== "string" || !b.text) {
        this.sendError(ws, "OMEW_KIND_INVALID_FOR_ROOM", `sections require a titled post (title <= ${POST_TITLE_MAX} chars, text required)`);
        return;
      }
    } else if (kind !== "reply") {
      this.sendError(ws, "OMEW_KIND_INVALID_FOR_ROOM", "sections only accept replies under a post");
      return;
    }

    const isSectionPost = roomKind === "sec" && isTopLevel;
    const feature = roomKind === "ch" ? "chat" : "posts";
    const strongholdId = attachment.room.split("/")[0]!;
    const restrictions = await this.ensureFeatureRestrictions(strongholdId);
    if (featurePaused(restrictions[feature])) {
      this.sendError(ws, "OMEW_FEATURE_RESTRICTED", `${feature} is temporarily paused`);
      return;
    }

    const requiredBit = parentSeq != null
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
      .exec<{ seq: number }>(
        "SELECT seq FROM dedupe_local WHERE origin = ? AND client_id = ?",
        homeOrigin,
        clientId
      )
      .toArray();
    if (existing.length > 0) {
      this.sendAck(ws, { status: "duplicate", client_id: clientId, seq: existing[0]!.seq });
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
      seq, parentSeq, rootSeq, attachment.actor, homeOrigin, clientId, kind, ts, bodyJson
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO dedupe_local (origin, client_id, seq, ts) VALUES (?, ?, ?, ?)",
      homeOrigin, clientId, seq, ts
    );

    if (isSectionPost) {
      this.ctx.storage.sql.exec(
        "INSERT INTO post_index (post_seq, last_reply_seq, reply_count, bumped_at) VALUES (?, ?, 0, ?)",
        seq, seq, ts
      );
    } else if (roomKind === "sec" && !isTopLevel) {
      // Sort/bump index updates synchronously and always (absolute, idempotent);
      // only the broadcast of that state is throttled, in scheduleBump below.
      this.ctx.storage.sql.exec(
        "INSERT INTO post_index (post_seq, last_reply_seq, reply_count, bumped_at) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT(post_seq) DO UPDATE SET last_reply_seq = excluded.last_reply_seq, " +
          "reply_count = post_index.reply_count + 1, bumped_at = excluded.bumped_at",
        rootSeq, seq, ts
      );
      this.scheduleBump(rootSeq);
    }

    this.sendAck(ws, { status: "ok", client_id: clientId, seq });
    this.enqueueBroadcast(ws, {
      type: "item.create",
      seq, parent_seq: parentSeq, root_seq: rootSeq,
      actor: attachment.actor, kind, ts, body: finalBody,
    });
    this.reportTip(attachment.room, seq);
  }

  private async handleItemUpdate(ws: WebSocket, attachment: Attachment, frame: Record<string, unknown>): Promise<void> {
    const targetSeq = Number(frame.target_seq);
    const body = frame.body;
    if (!Number.isFinite(targetSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.update");
      return;
    }
    const result = await this.performEdit(attachment.actor, attachment.room, targetSeq, body, ws);
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }
    this.sendAck(ws, { status: "ok", target_seq: targetSeq, seq: result.seq });
  }

  private async handleItemDelete(ws: WebSocket, attachment: Attachment, frame: Record<string, unknown>): Promise<void> {
    const targetSeq = Number(frame.target_seq);
    const reason = frame.reason == null ? undefined : String(frame.reason);
    if (!Number.isFinite(targetSeq)) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.delete");
      return;
    }
    const result = await this.performRetract(attachment.actor, attachment.role, attachment.room, targetSeq, reason, ws);
    if (!result.ok) {
      this.sendError(ws, result.code, result.message);
      return;
    }
    // m0-protocol S3.2: repeated item.delete is an idempotent no-op - result.seq is
    // null when the target was already tombstoned, no new event was broadcast.
    this.sendAck(ws, result.seq == null ? { status: "ok", target_seq: targetSeq } : { status: "ok", target_seq: targetSeq, seq: result.seq });
  }

  // m0-protocol §3.2a: engagement toggle, never occupies seq, not gated by deny
  // bits. Rate limiting is already applied once per frame in webSocketMessage
  // above (shared actor bucket), so this handler doesn't take a token itself.
  private handleItemReaction(ws: WebSocket, attachment: Attachment, frame: Record<string, unknown>): void {
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
      this.sendError(ws, "OMEW_MALFORMED", "bad item.reaction", { target_seq: rawTargetSeq, name: rawName });
      return;
    }
    const targetSeq = rawTargetSeq as number;
    const name = rawName;
    if (!/^[\x20-\x7e]{1,64}$/.test(name) || (op !== "add" && op !== "remove")) {
      this.sendError(ws, "OMEW_MALFORMED", "bad item.reaction", { target_seq: targetSeq, name });
      return;
    }

    const target = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM item WHERE seq = ?", targetSeq).toArray();
    if (target.length === 0) {
      this.sendError(ws, "OMEW_TARGET_NOT_FOUND", "target not found", { target_seq: targetSeq, name });
      return;
    }
    const tomb = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq).toArray();
    if (tomb.length > 0) {
      this.sendError(ws, "OMEW_ITEM_DELETED", "target already deleted", { target_seq: targetSeq, name });
      return;
    }

    // Per-(actor, target, name) toggle is idempotent: duplicate add and a
    // missing remove are silent no-ops, never errors.
    if (op === "add") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO reaction (target_seq, name, actor, ts) VALUES (?, ?, ?, ?)",
        targetSeq, name, attachment.actor, Date.now()
      );
    } else {
      this.ctx.storage.sql.exec(
        "DELETE FROM reaction WHERE target_seq = ? AND name = ? AND actor = ?",
        targetSeq, name, attachment.actor
      );
    }

    const entries = this.ctx.storage.sql
      .exec<{ name: string; count: number }>(
        "SELECT name, COUNT(*) AS count FROM reaction WHERE target_seq = ? GROUP BY name ORDER BY name",
        targetSeq
      )
      .toArray();

    // Absolute snapshot, same shape to sender and everyone else - sender gets it
    // immediately (not batched), the rest via the usual batching window.
    const responseFrame = { type: "item.reaction", target_seq: targetSeq, entries, actor: attachment.actor, name, op };
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
  async editItem(actor: string, roomRef: string, targetSeq: number, content: unknown): Promise<EditOutcome> {
    return this.performEdit(actor, roomRef, targetSeq, content, null);
  }

  async retractItem(actor: string, role: Role, roomRef: string, targetSeq: number, reason?: string): Promise<RetractOutcome> {
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
    excludeWs: WebSocket | null
  ): Promise<EditOutcome> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, code: "OMEW_MALFORMED", message: "body must be an object" };
    }
    const target = this.ctx.storage.sql.exec<ItemRow>("SELECT * FROM item WHERE seq = ?", targetSeq).toArray();
    if (target.length === 0) {
      return { ok: false, code: "OMEW_TARGET_NOT_FOUND", message: "target not found" };
    }
    const tomb = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq).toArray();
    if (tomb.length > 0) {
      return { ok: false, code: "OMEW_ITEM_DELETED", message: "target already deleted" };
    }
    if (target[0]!.actor !== actor) {
      return { ok: false, code: "OMEW_FORBIDDEN", message: "only the author may edit" };
    }

    const strongholdId = roomRef.split("/")[0]!;
    const cfg = await this.ensureEditConfig(strongholdId);
    if (!cfg.allow_message_edit) {
      return { ok: false, code: "EDIT_DISABLED", message: "message editing is disabled for this stronghold" };
    }
    if (cfg.edit_window_secs > 0 && (Date.now() - target[0]!.ts) / 1000 > cfg.edit_window_secs) {
      return { ok: false, code: "WINDOW_EXPIRED", message: "edit window has expired" };
    }

    // Section top-level post: preview is server-derived and folded into the
    // stored body at create time (handleItemCreate's isSectionPost branch) - an
    // edit MUST re-fold it the same way, or list/post reads keep the stale preview.
    const roomKind = roomRef.split("/")[1];
    const isSectionPost = roomKind === "sec" && target[0]!.parent_seq == null;
    const b = body as Record<string, unknown>;
    if ("topics" in b) return { ok: false, code: "OMEW_MALFORMED", message: "topics are no longer supported" };
    const finalBody: unknown = isSectionPost && typeof b.text === "string"
      ? { ...b, preview: markdownPreview(b.text, PREVIEW_LEN) }
      : b;

    const editedAt = Date.now();
    const seq = this.allocateSeq();
    const bodyJson = JSON.stringify(finalBody);
    this.ctx.storage.sql.exec(
      "INSERT INTO edit (target_seq, seq, body, edited_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(target_seq) DO UPDATE SET seq = excluded.seq, body = excluded.body, edited_at = excluded.edited_at",
      targetSeq, seq, bodyJson, editedAt
    );

    this.enqueueBroadcast(excludeWs, { type: "item.update", seq, target_seq: targetSeq, body: finalBody, edited_at: editedAt });
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
    excludeWs: WebSocket | null
  ): Promise<RetractOutcome> {
    const alreadyTombstoned = this.ctx.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM tombstone WHERE seq = ?", targetSeq)
      .toArray();
    if (alreadyTombstoned.length > 0) {
      return { ok: true, seq: null };
    }

    const target = this.ctx.storage.sql.exec<ItemRow>("SELECT * FROM item WHERE seq = ?", targetSeq).toArray();
    if (target.length === 0) {
      return { ok: false, code: "OMEW_TARGET_NOT_FOUND", message: "target not found" };
    }

    const isAuthor = target[0]!.actor === actor;
    const isModerator = role === "mod" || role === "owner";
    if (!isAuthor && !isModerator) {
      return { ok: false, code: "OMEW_FORBIDDEN", message: "not author or moderator" };
    }

    const strongholdId = roomRef.split("/")[0]!;
    if (isAuthor) {
      const cfg = await this.ensureEditConfig(strongholdId);
      if (!cfg.allow_message_retract) {
        return { ok: false, code: "RETRACT_DISABLED", message: "message retraction is disabled for this stronghold" };
      }
      if (cfg.edit_window_secs > 0 && (Date.now() - target[0]!.ts) / 1000 > cfg.edit_window_secs) {
        return { ok: false, code: "WINDOW_EXPIRED", message: "retract window has expired" };
      }
    } else if (role === "mod") {
      const stub = this.env.STRONGHOLD_DO.getByName(strongholdId);
      const authorMember = await stub.getMember(target[0]!.actor);
      if (authorMember && authorMember.role === "owner") {
        return { ok: false, code: "OMEW_FORBIDDEN", message: "mod cannot delete the owner's item" };
      }
    }
    const byRole: "author" | "mod" | "owner" = isAuthor ? "author" : (role as "mod" | "owner");

    const ts = Date.now();
    const seq = this.allocateSeq();
    this.ctx.storage.sql.exec(
      "INSERT INTO tombstone (seq, actor, ts, reason) VALUES (?, ?, ?, ?)",
      targetSeq, actor, ts, reason ?? null
    );

    this.enqueueBroadcast(excludeWs, { type: "item.delete", seq, target_seq: targetSeq, reason, by_role: byRole });
    this.reportTip(roomRef, seq);
    return { ok: true, seq };
  }

  // S4.4: RoomDO -> StrongholdDO after each commit; fire-and-forget, never blocks
  // the ack/broadcast path. StrongholdDO persists before its own coalesced flush.
  private reportTip(roomRef: string, seq: number): void {
    const strongholdId = roomRef.split("/")[0]!;
    const stub = this.env.STRONGHOLD_DO.getByName(strongholdId);
    this.ctx.waitUntil(stub.reportTip(roomRef, seq).catch(() => {}));
  }

  // S5.3 resync: gap <= 500 replays directly, larger gaps defer to the history API.
  private handleResync(ws: WebSocket, frame: Record<string, unknown>): void {
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
        ws.send(JSON.stringify({ type: "resync_gap", gap: true, from: fromSeq, to: currentMax }));
      } catch {
        // socket already gone; nothing to clean up.
      }
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<ItemRow & { edit_body: string | null; edited_at: number | null; tomb_seq: number | null }>(
        `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
         FROM item i
         LEFT JOIN edit e ON e.target_seq = i.seq
         LEFT JOIN tombstone t ON t.seq = i.seq
         WHERE i.seq > ? ORDER BY i.seq ASC`,
        fromSeq
      )
      .toArray();

    const items = rows
      .filter((r) => r.tomb_seq == null)
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
    const requester = (ws.deserializeAttachment() as Attachment | null)?.actor ?? null;
    try {
      ws.send(JSON.stringify({ type: "batch", items: this.attachReactions(items, (i) => i.seq, requester) }));
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
    actor: string | null
  ): (T & { reactions: { entries: { name: string; count: number }[]; mine: string[] } })[] {
    if (rows.length === 0) return [];
    const seqs = rows.map(seqOf);
    const placeholders = seqs.map(() => "?").join(",");

    const entryRows = this.ctx.storage.sql
      .exec<{ target_seq: number; name: string; count: number }>(
        `SELECT target_seq, name, COUNT(*) AS count FROM reaction WHERE target_seq IN (${placeholders}) GROUP BY target_seq, name ORDER BY name`,
        ...seqs
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
        .exec<{ target_seq: number; name: string }>(
          `SELECT target_seq, name FROM reaction WHERE actor = ? AND target_seq IN (${placeholders})`,
          actor, ...seqs
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
      return { ...row, reactions: { entries: entriesBySeq.get(seq) ?? [], mine: mineBySeq.get(seq) ?? [] } };
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

  private sendError(ws: WebSocket, code: string, message: string, extra?: Record<string, unknown>): void {
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
  private enqueueBroadcast(senderWs: WebSocket | null, frame: Record<string, unknown>): void {
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
      const frames = batch.filter((e) => e.senderWs !== ws).map((e) => e.frame);
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
    const timer = setTimeout(() => this.flushBump(postSeq), delay);
    this.bumpTimers.set(postSeq, timer);
  }

  private flushBump(postSeq: number): void {
    this.bumpTimers.delete(postSeq);
    const tomb = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM tombstone WHERE seq = ?", postSeq).toArray();
    if (tomb.length > 0) return; // post retracted meanwhile - nothing to bump.
    const idx = this.ctx.storage.sql
      .exec<{ last_reply_seq: number; reply_count: number; bumped_at: number }>(
        "SELECT last_reply_seq, reply_count, bumped_at FROM post_index WHERE post_seq = ?", postSeq
      )
      .toArray()[0];
    if (!idx) return;
    const post = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM item WHERE seq = ?", postSeq).toArray()[0];
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
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        continue;
      }
    }
  }

  // S9: token bucket per actor, not per connection.
  private takeRateToken(actor: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(actor) ?? { tokens: RATE_LIMIT_CAPACITY, last: now };
    const elapsedSec = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.rateBuckets.set(actor, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.rateBuckets.set(actor, bucket);
    return true;
  }

  // ---- history RPC ------------------------------------------------------------

  // S5.3: pagination is seq-anchored, never timestamp-anchored.
  async getHistory(beforeSeq: number | null, limit: number, actor: string | null = null): Promise<unknown[]> {
    const cappedLimit = Math.max(1, Math.min(limit || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT));
    const rows = beforeSeq == null
      ? this.ctx.storage.sql
          .exec<ItemRow & { edit_body: string | null; edited_at: number | null; tomb_seq: number | null }>(
            `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
             FROM item i
             LEFT JOIN edit e ON e.target_seq = i.seq
             LEFT JOIN tombstone t ON t.seq = i.seq
             ORDER BY i.seq DESC LIMIT ?`,
            cappedLimit
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<ItemRow & { edit_body: string | null; edited_at: number | null; tomb_seq: number | null }>(
            `SELECT i.*, e.body AS edit_body, e.edited_at, t.seq AS tomb_seq
             FROM item i
             LEFT JOIN edit e ON e.target_seq = i.seq
             LEFT JOIN tombstone t ON t.seq = i.seq
             WHERE i.seq < ? ORDER BY i.seq DESC LIMIT ?`,
            beforeSeq, cappedLimit
          )
          .toArray();

    const items = rows
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
    return this.attachReactions(items, (i) => i.seq, actor);
  }

  // ---- section posts RPC (proposal S4.5) ---------------------------------------

  // Sorted by bumped_at desc (most recently active thread first), composite
  // (bumped_at, post_seq) cursor so a tie at the same millisecond still paginates
  // deterministically.
  async listPosts(after: string | null, limit?: number, actor: string | null = null): Promise<{ posts: unknown[]; next_cursor: string | null }> {
    const cappedLimit = Math.max(1, Math.min(limit || POSTS_DEFAULT_LIMIT, POSTS_MAX_LIMIT));
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
               WHERE t.seq IS NULL AND (p.bumped_at < ? OR (p.bumped_at = ? AND p.post_seq < ?))
               ORDER BY p.bumped_at DESC, p.post_seq DESC LIMIT ?`;
    const params: unknown[] = [cursorBumpedAt, cursorBumpedAt, cursorSeq, cappedLimit + 1];

    const rows = this.ctx.storage.sql
      .exec<{
        post_seq: number; last_reply_seq: number; reply_count: number; bumped_at: number;
        actor: string; ts: number; body: string; edit_body: string | null; edited_at: number | null;
      }>(
        query,
        ...params
      )
      .toArray();

    const hasMore = rows.length > cappedLimit;
    const page = rows.slice(0, cappedLimit);
    const posts = page.map((r) => {
      const body = JSON.parse(r.edit_body ?? r.body) as { title?: string; cover?: string; preview?: string; media?: unknown };
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
    const next_cursor = hasMore && last ? `${last.bumped_at}:${last.post_seq}` : null;
    return { posts: this.attachReactions(posts, (p) => p.post_seq, actor), next_cursor };
  }

  // section room post_count for the rooms list - a plain count, not
  // listPosts's full page (avoids pulling the whole post_index + item join).
  async countPosts(): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM post_index p LEFT JOIN tombstone t ON t.seq = p.post_seq WHERE t.seq IS NULL"
      )
      .one().n;
  }

  // Post detail + seq-anchored reply page (same before/limit idiom as getHistory).
  async getPost(postSeq: number, before: number | null, limit?: number, actor: string | null = null): Promise<{ post: unknown; replies: unknown[]; next_before: number | null } | null> {
    const postRows = this.ctx.storage.sql
      .exec<ItemRow & { tomb_seq: number | null; edit_body: string | null; edited_at: number | null }>(
        `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
         FROM item i
         LEFT JOIN tombstone t ON t.seq = i.seq
         LEFT JOIN edit e ON e.target_seq = i.seq
         WHERE i.seq = ?`,
        postSeq
      )
      .toArray();
    const postRow = postRows[0];
    if (!postRow || postRow.tomb_seq != null || postRow.kind !== "post" || postRow.parent_seq != null) {
      return null;
    }
    const idx = this.ctx.storage.sql
      .exec<{ last_reply_seq: number; reply_count: number; bumped_at: number }>(
        "SELECT last_reply_seq, reply_count, bumped_at FROM post_index WHERE post_seq = ?", postSeq
      )
      .toArray()[0];
    const body = JSON.parse(postRow.edit_body ?? postRow.body) as { title?: string; text?: string; cover?: string; preview?: string; media?: unknown };
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

    const cappedLimit = Math.max(1, Math.min(limit || HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT));
    const replyRows = before == null
      ? this.ctx.storage.sql
          .exec<ItemRow & { tomb_seq: number | null; edit_body: string | null; edited_at: number | null }>(
            `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
             FROM item i
             LEFT JOIN tombstone t ON t.seq = i.seq
             LEFT JOIN edit e ON e.target_seq = i.seq
             WHERE i.root_seq = ? AND i.parent_seq IS NOT NULL ORDER BY i.seq DESC LIMIT ?`,
            postSeq, cappedLimit
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<ItemRow & { tomb_seq: number | null; edit_body: string | null; edited_at: number | null }>(
            `SELECT i.*, t.seq AS tomb_seq, e.body AS edit_body, e.edited_at
             FROM item i
             LEFT JOIN tombstone t ON t.seq = i.seq
             LEFT JOIN edit e ON e.target_seq = i.seq
             WHERE i.root_seq = ? AND i.parent_seq IS NOT NULL AND i.seq < ? ORDER BY i.seq DESC LIMIT ?`,
            postSeq, before, cappedLimit
          )
          .toArray();

    const replies = replyRows
      .filter((r) => r.tomb_seq == null)
      .map((r) => ({ seq: r.seq, actor: r.actor, ts: r.ts, body: withoutTopics(JSON.parse(r.edit_body ?? r.body)), edited_at: r.edited_at ?? undefined }));
    const lastRow = replyRows[replyRows.length - 1];
    const next_before = replyRows.length === cappedLimit && lastRow ? lastRow.seq : null;
    return {
      post: this.attachReactions([post], (p) => p.post_seq, actor)[0],
      replies: this.attachReactions(replies, (r) => r.seq, actor),
      next_before,
    };
  }
}
