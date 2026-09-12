import { DurableObject } from "cloudflare:workers";
import { verifyToken } from "./auth";
import { synthesizeEffectivePermissions, type EffectivePermissions, type ServerGroupPermInput } from "./permissions";
import { typeToKind, type Role, type RoomType, type StrongholdTokenClaims } from "./types";
import { domainOfActor, localpartOfActor } from "./users";

// proposal S4.1/S4.4: stronghold config + capability rules + authoritative member
// table + persisted tips aggregate, with a WS fan-out for tip.update pushes.

const TIP_FLUSH_MS = 1_500; // m0-protocol S3.3: tip.update coalesced, not per-message.

// `type` (not `interface`) so these structurally satisfy the SqlStorageValue
// index-signature constraint that sql.exec<T>() requires.
export type ConfigRow = {
  id: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  icon: string | null;
  avatar: string | null;
  cover: string | null;
  allow_message_edit: number;
  allow_message_retract: number;
  edit_window_secs: number;
  owner_chat_paused: number;
  owner_chat_expires_at: number | null;
  owner_posts_paused: number;
  owner_posts_expires_at: number | null;
  owner_actor: string;
  created_at: number;
  slug: string;
};

export type RoomRow = {
  res_id: string;
  type: RoomType;
  name: string;
  description: string | null;
  capabilities_json: string;
  restricted: number;
  position: number | null;
  archived: number;
  created_at: number;
};

// URL short-name derivation, shared by direct creation and
// application approval. Lowercase, non [a-z0-9] folds to '-', collapses runs,
// trims edges, caps at 32 - an all-non-ASCII name collapses to empty, which
// falls back to a random short string rather than an empty slug.
export function deriveSlugBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export type MemberRow = {
  actor: string;
  role: Role;
  deny: number;
  restricted: number;
  banned_at: number | null;
  expires_at: number | null;
  application_state: "pending" | "approved" | "rejected";
  joined_at: number;
};

export type BanRow = {
  actor: string;
  operator: string;
  banned_at: number;
  expires_at: number | null;
};

interface TipAttachment {
  actor: string;
  stronghold: string;
  role: Role;
}

export interface EditConfigSnapshot {
  allow_message_edit: boolean;
  allow_message_retract: boolean;
  edit_window_secs: number;
}

export type RestrictedFeature = "chat" | "posts";
export type ServerFeatureOverride = "inherit" | "force_allow" | "force_pause";

export interface FeatureRestrictionRule {
  owner_paused: boolean;
  owner_expires_at: number | null;
  server_override: ServerFeatureOverride;
  server_expires_at: number | null;
}

export interface FeatureRestrictionSnapshot {
  chat: FeatureRestrictionRule;
  posts: FeatureRestrictionRule;
}

export function featurePaused(rule: FeatureRestrictionRule, now = Date.now()): boolean {
  const serverActive = rule.server_override !== "inherit" && (rule.server_expires_at === null || rule.server_expires_at > now);
  if (serverActive) return rule.server_override === "force_pause";
  return rule.owner_paused && (rule.owner_expires_at === null || rule.owner_expires_at > now);
}

// m0-protocol §7.3 revocation propagation: local-only DO-to-DO frame (never
// crosses federation, never occupies seq, never enters a dedupe table).
// `effect: "close"` is a hard kick (ban/remove); `effect: "update_deny"` is a
// live role/deny change - role/deny are pre-computed by StrongholdDO (via
// revokeActor, so groups are already folded in) so RoomDO never has to call
// back into StrongholdDO per revoke.
export interface MemberRevokePayload {
  actor: string;
  scope: string;
  effect: "close" | "update_deny";
  role?: Role;
  deny?: number;
}

// D1 lookup of a local user's held server
// groups, position-ordered - the input shape synthesizeEffectivePermissions
// (permissions.ts) expects. Shared by StrongholdDO.revokeActor and api.ts's
// effectiveRole, the only two places that fold server groups into a role/deny.
export async function fetchServerGroupsForLocalpart(env: Env, localpart: string): Promise<ServerGroupPermInput[]> {
  const { results } = await env.DB.prepare(
    "SELECT g.position, g.allow_speak, g.allow_post, g.allow_reply, g.is_moderator " +
      "FROM user_server_groups usg JOIN server_groups g ON g.id = usg.group_id WHERE usg.localpart = ?"
  )
    .bind(localpart)
    .all<ServerGroupPermInput>();
  return results;
}

export class StrongholdDO extends DurableObject<Env> {
  // DOs created via getByName always carry their name back on ctx.id - used to
  // key the D1 membership index without an extra config read on every call.
  private readonly selfId: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.selfId = ctx.id.name ?? ctx.id.toString();
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.backfillSlug();
    });
  }

  // Best-effort side index (GET /api/me/strongholds) - the `member` table above
  // stays the sole authority for actual membership; a failed sync here just means
  // that endpoint under/over-reports until the next successful mutation.
  private async indexMember(actor: string): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO stronghold_member_index (actor, stronghold_id) VALUES (?, ?) ON CONFLICT(actor, stronghold_id) DO NOTHING"
    ).bind(actor, this.selfId).run().catch(() => {});
  }

  private async unindexMember(actor: string): Promise<void> {
    await this.env.DB.prepare(
      "DELETE FROM stronghold_member_index WHERE actor = ? AND stronghold_id = ?"
    ).bind(actor, this.selfId).run().catch(() => {});
  }

  // The StrongholdDO remains authoritative. This projection makes the public
  // directory one D1 query instead of two DO calls for every displayed card.
  private async syncDirectoryIndex(config: ConfigRow): Promise<void> {
    const memberCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM member")
      .one().count;
    await this.env.DB.prepare(
      "INSERT INTO stronghold_directory_index (stronghold_id, name, description, avatar, cover, visibility, member_count, slug, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(stronghold_id) DO UPDATE SET name = excluded.name, description = excluded.description, avatar = excluded.avatar, " +
      "cover = excluded.cover, visibility = excluded.visibility, member_count = excluded.member_count, slug = excluded.slug, updated_at = excluded.updated_at"
    ).bind(config.id, config.name, config.description, config.avatar, config.cover, config.visibility, memberCount, config.slug, Date.now()).run();
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        visibility TEXT NOT NULL, icon TEXT, owner_actor TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room (
        res_id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, restricted INTEGER NOT NULL DEFAULT 0,
        position INTEGER, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member (
        actor TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member',
        deny INTEGER NOT NULL DEFAULT 0, restricted INTEGER NOT NULL DEFAULT 0,
        banned_at INTEGER, expires_at INTEGER, application_state TEXT NOT NULL DEFAULT 'approved', joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tip (
        room_ref TEXT PRIMARY KEY, latest_seq INTEGER NOT NULL, ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ban (
        actor TEXT PRIMARY KEY, operator TEXT NOT NULL, banned_at INTEGER NOT NULL, expires_at INTEGER
      );
    `);
    this.addColumnIfMissing("config", "slug", "TEXT");
    // 标签功能已移除；旧据点的本地持久化数据不再保留。
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS topic;");
    this.addColumnIfMissing("room", "description", "TEXT");
    // Stronghold-local groups moved to server-level D1
    // tables (server_groups/user_server_groups, migration 0009) - drop the
    // per-DO tables outright, no migration of their data.
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS groups; DROP TABLE IF EXISTS member_groups;`);
    // Stronghold-level settings added after the config table already existed in
    // deployed strongholds - additive ALTER, guarded so it's a no-op once a DO
    // has already picked the columns up.
    this.addColumnIfMissing("config", "cover", "TEXT");
    this.addColumnIfMissing("config", "avatar", "TEXT");
    this.addColumnIfMissing("member", "expires_at", "INTEGER");
    this.addColumnIfMissing("ban", "expires_at", "INTEGER");
    this.addColumnIfMissing("config", "allow_message_edit", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("config", "allow_message_retract", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("config", "edit_window_secs", "INTEGER NOT NULL DEFAULT 300");
    this.addColumnIfMissing("config", "owner_chat_paused", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("config", "owner_chat_expires_at", "INTEGER");
    this.addColumnIfMissing("config", "owner_posts_paused", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("config", "owner_posts_expires_at", "INTEGER");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
    if (!cols.some((c) => c.name === column)) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // strongholds created before the slug column existed have
  // slug = NULL - backfill with the stronghold's own id (already globally
  // unique) and best-effort mirror that into the D1 reverse index so
  // GET /api/resolve/:server/:slug finds them too. Runs every wake-up but is
  // a no-op past the first once every row has a slug.
  private async backfillSlug(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ id: string; slug: string | null }>("SELECT id, slug FROM config").toArray();
    for (const row of rows) {
      if (row.slug) continue;
      this.ctx.storage.sql.exec("UPDATE config SET slug = ? WHERE id = ?", row.id, row.id);
      await this.env.DB.prepare(
        "INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      )
        .bind(row.id, row.id)
        .run()
        .catch(() => {});
    }
  }

  // ---- config -----------------------------------------------------------------

  async initConfig(
    id: string,
    name: string,
    visibility: "public" | "private",
    ownerActor: string,
    description?: string,
    icon?: string,
    slug?: string
  ): Promise<ConfigRow> {
    const existing = this.ctx.storage.sql.exec<ConfigRow>("SELECT * FROM config WHERE id = ?", id).toArray();
    if (existing.length > 0) return existing[0]!;
    const createdAt = Date.now();
    const resolvedSlug = slug ?? id;
    this.ctx.storage.sql.exec(
      "INSERT INTO config (id, name, description, visibility, icon, avatar, cover, allow_message_edit, allow_message_retract, edit_window_secs, owner_chat_paused, owner_chat_expires_at, owner_posts_paused, owner_posts_expires_at, owner_actor, created_at, slug) " +
        "VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 1, 300, 0, NULL, 0, NULL, ?, ?, ?)",
      id, name, description ?? null, visibility, icon ?? null, ownerActor, createdAt, resolvedSlug
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO member (actor, role, deny, restricted, application_state, joined_at) VALUES (?, 'owner', 0, 0, 'approved', ?)",
      ownerActor, createdAt
    );
    await this.indexMember(ownerActor);
    // Direct StrongholdDO callers (tests and maintenance tools) must create the
    // same global enumeration row as the HTTP creation route.
    await this.env.DB.prepare(
      "INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
    ).bind(resolvedSlug, id).run();
    const config: ConfigRow = {
      id, name, description: description ?? null, visibility, icon: icon ?? null, avatar: null, cover: null,
      allow_message_edit: 1, allow_message_retract: 1, edit_window_secs: 300,
      owner_chat_paused: 0, owner_chat_expires_at: null, owner_posts_paused: 0, owner_posts_expires_at: null,
      owner_actor: ownerActor, created_at: createdAt, slug: resolvedSlug,
    };
    await this.syncDirectoryIndex(config);
    return config;
  }

  async ensureConfigWithDefaults(
    id: string,
    name: string,
    visibility: "public" | "private",
    ownerActor: string,
    description: string,
    slug: string,
  ): Promise<ConfigRow> {
    const config = await this.initConfig(id, name, visibility, ownerActor, description, undefined, slug);
    if (!(await this.getRoom("lobby"))) await this.createRoom("lobby", "channel", "大厅", ["text"], false);
    if (!(await this.getRoom("posts"))) await this.createRoom("posts", "section", "帖子", ["text"], false);
    return config;
  }

  // server admin-only slug rename (api.ts holds the D1-index
  // uniqueness check + gate; this just applies the already-resolved value).
  async updateSlug(newSlug: string): Promise<ConfigRow | null> {
    const current = await this.getConfig();
    if (!current) return null;
    this.ctx.storage.sql.exec("UPDATE config SET slug = ? WHERE id = ?", newSlug, current.id);
    const updated = { ...current, slug: newSlug };
    await this.syncDirectoryIndex(updated);
    return updated;
  }

  async getConfig(): Promise<ConfigRow | null> {
    try {
      const rows = this.ctx.storage.sql.exec<ConfigRow>("SELECT * FROM config LIMIT 1").toArray();
      return rows[0] ?? null;
    } catch {
      // deleteAll() removes SQLite's schema too. A warm object can still serve
      // one last request before its constructor runs again; it is simply gone.
      return null;
    }
  }

  async updateConfig(
    patch: Partial<
      Pick<
        ConfigRow,
        "name" | "description" | "visibility" | "icon" | "avatar" | "cover" | "allow_message_edit" | "allow_message_retract" | "edit_window_secs"
      >
    >
  ): Promise<ConfigRow | null> {
    const current = await this.getConfig();
    if (!current) return null;
    const next = { ...current, ...patch };
    this.ctx.storage.sql.exec(
      "UPDATE config SET name = ?, description = ?, visibility = ?, icon = ?, avatar = ?, cover = ?, " +
        "allow_message_edit = ?, allow_message_retract = ?, edit_window_secs = ? WHERE id = ?",
      next.name, next.description, next.visibility, next.icon, next.avatar, next.cover,
      next.allow_message_edit, next.allow_message_retract, next.edit_window_secs, next.id
    );
    await this.syncDirectoryIndex(next);
    // Push the edit-policy slice to every room DO this stronghold owns (DO-to-DO,
    // fire-and-forget) so RoomDO write paths never query D1/config on the hot
    // path - only StrongholdDO changes trigger a refresh.
    await this.pushEditConfigToRooms(next);
    return next;
  }

  private async pushEditConfigToRooms(config: ConfigRow): Promise<void> {
    const rooms = await this.listRooms();
    const snapshot: EditConfigSnapshot = {
      allow_message_edit: Boolean(config.allow_message_edit),
      allow_message_retract: Boolean(config.allow_message_retract),
      edit_window_secs: config.edit_window_secs,
    };
    await Promise.all(
      rooms.map((room) => {
        const roomRef = `${config.id}/${typeToKind(room.type)}/${room.res_id}`;
        const stub = this.env.ROOM_DO.getByName(roomRef);
        return stub.setEditConfig(snapshot).catch(() => {
          // best-effort push; the room DO's own query-back fallback (RoomDO
          // ensureEditConfig) covers a missed push on its next gated write.
        });
      })
    );
  }

  async getFeatureRestrictions(): Promise<FeatureRestrictionSnapshot | null> {
    const config = await this.getConfig();
    if (!config) return null;
    const { results } = await this.env.DB.prepare(
      "SELECT feature, mode, expires_at FROM stronghold_feature_overrides WHERE stronghold_id = ?"
    ).bind(config.id).all<{ feature: RestrictedFeature; mode: ServerFeatureOverride; expires_at: number | null }>();
    const overrides = new Map(results.map((row) => [row.feature, row]));
    const rule = (feature: RestrictedFeature, paused: number, expiresAt: number | null): FeatureRestrictionRule => {
      const override = overrides.get(feature);
      return {
        owner_paused: Boolean(paused), owner_expires_at: expiresAt,
        server_override: override?.mode ?? "inherit", server_expires_at: override?.expires_at ?? null,
      };
    };
    return {
      chat: rule("chat", config.owner_chat_paused, config.owner_chat_expires_at),
      posts: rule("posts", config.owner_posts_paused, config.owner_posts_expires_at),
    };
  }

  async updateOwnerFeatureRestriction(feature: RestrictedFeature, paused: boolean, expiresAt: number | null): Promise<FeatureRestrictionSnapshot | null> {
    const config = await this.getConfig();
    if (!config) return null;
    const pausedColumn = feature === "chat" ? "owner_chat_paused" : "owner_posts_paused";
    const expiresColumn = feature === "chat" ? "owner_chat_expires_at" : "owner_posts_expires_at";
    const previousPaused = feature === "chat" ? config.owner_chat_paused : config.owner_posts_paused;
    const previousExpiry = feature === "chat" ? config.owner_chat_expires_at : config.owner_posts_expires_at;
    this.ctx.storage.sql.exec(`UPDATE config SET ${pausedColumn} = ?, ${expiresColumn} = ? WHERE id = ?`, paused ? 1 : 0, paused ? expiresAt : null, config.id);
    try {
      const snapshot = await this.getFeatureRestrictions();
      if (snapshot) await this.pushFeatureRestrictionsToRooms(config, snapshot);
      return snapshot;
    } catch (error) {
      this.ctx.storage.sql.exec(`UPDATE config SET ${pausedColumn} = ?, ${expiresColumn} = ? WHERE id = ?`, previousPaused, previousExpiry, config.id);
      throw error;
    }
  }

  async refreshFeatureRestrictions(): Promise<FeatureRestrictionSnapshot | null> {
    const config = await this.getConfig();
    const snapshot = await this.getFeatureRestrictions();
    if (config && snapshot) await this.pushFeatureRestrictionsToRooms(config, snapshot);
    return snapshot;
  }

  private async pushFeatureRestrictionsToRooms(config: ConfigRow, snapshot: FeatureRestrictionSnapshot): Promise<void> {
    const rooms = await this.listRooms();
    await Promise.all(rooms.map((room) => this.env.ROOM_DO.getByName(`${config.id}/${typeToKind(room.type)}/${room.res_id}`)
      .setFeatureRestrictions(snapshot)));
  }

  // ---- revocation propagation (m0-protocol §7.3) --------------------------------
  // Same DO-to-DO fire-and-forget convention as pushEditConfigToRooms above: every
  // room DO this stronghold owns gets the frame, a failed push to one room never
  // blocks the others or the caller's own mutation.

  private async pushRevokeToRooms(payload: MemberRevokePayload): Promise<void> {
    // §7.3 covers stronghold-level WS tokens too ("MUST NOT rely on token
    // natural expiry"), so a hard revoke also tears down the actor's tips
    // sockets (§10.6) on this very DO. update_deny doesn't apply: the tips
    // channel grants no write access, role/deny changes can't affect it.
    if (payload.effect === "close") {
      this.closeTipSockets(payload.actor);
    } else if (payload.role) {
      await this.updateTipSockets(payload.actor, payload.role);
    }
    const rooms = await this.listRooms();
    await Promise.all(
      rooms.map((room) => {
        const roomRef = `${this.selfId}/${typeToKind(room.type)}/${room.res_id}`;
        const stub = this.env.ROOM_DO.getByName(roomRef);
        return stub.revokeMember(payload).catch(() => {});
      })
    );
  }

  private closeTipSockets(actor: string): void {
    for (const ws of this.ctx.getWebSockets("tips")) {
      const attachment = ws.deserializeAttachment() as TipAttachment | null;
      if (!attachment || attachment.actor !== actor) continue;
      try {
        ws.close(1008, "OMEW_SESSION_INVALID");
      } catch {
        // socket already gone.
      }
    }
  }

  private async updateTipSockets(actor: string, role: Role): Promise<void> {
    const tips = await this.getTipsForRole(role);
    const payload = JSON.stringify({ type: "tip.update", entries: tips });
    for (const ws of this.ctx.getWebSockets("tips")) {
      const attachment = ws.deserializeAttachment() as TipAttachment | null;
      if (!attachment || attachment.actor !== actor) continue;
      ws.serializeAttachment({ ...attachment, role });
      try {
        ws.send(payload);
      } catch {
        // socket already gone.
      }
    }
  }

  async revokeServerRole(actor: string): Promise<void> {
    this.closeTipSockets(actor);
    await this.pushRevokeToRooms({ actor, scope: this.selfId, effect: "close" });
  }

  // Recompute one actor's effective role/deny (server groups included, m0-protocol
  // §7.10a) and push it down to every room this stronghold owns. Public API for
  // server-group admin routes (api.ts, against D1) call this per affected actor
  // after a group mutation, since that mutation happens outside any single
  // StrongholdDO. null means the actor no longer resolves to any access (not a
  // member, or banned) - banMember/removeMember already send their own "close"
  // for that transition, nothing to do here.
  async revokeActor(actor: string): Promise<void> {
    const member = await this.getMember(actor);
    if (!member || member.banned_at) return;
    let eff: EffectivePermissions;
    if (member.role !== "member") {
      eff = { role: member.role, deny: 0 };
    } else {
      // Guests (federated actors) have no users row and thus no server groups.
      // RPC calls do not carry a Request; the owner actor permanently records
      // this stronghold's local instance domain.
      const config = await this.getConfig();
      const groups = config && domainOfActor(actor) === domainOfActor(config.owner_actor)
        ? await fetchServerGroupsForLocalpart(this.env, localpartOfActor(actor))
        : [];
      eff = synthesizeEffectivePermissions("member", member.deny, groups);
    }
    await this.pushRevokeToRooms({ actor, scope: this.selfId, effect: "update_deny", role: eff.role, deny: eff.deny });
  }

  // ---- rooms --------------------------------------------------------------------

  async createRoom(
    resId: string,
    type: RoomType,
    name: string,
    capabilities: string[],
    restricted: boolean,
    position?: number,
    description?: string | null
  ): Promise<RoomRow> {
    // m0-protocol §13.3: "text" is mandatory on every room; "reactions" (§3.2a) is
    // served for every room too, so it's forced into the registry the same way.
    const withText = capabilities.includes("text") ? capabilities : ["text", ...capabilities];
    const caps = withText.includes("reactions") ? withText : [...withText, "reactions"];
    const createdAt = Date.now();
    // listRooms orders by position first, so a room without one would sort ahead
    // of every explicitly ordered room - append it to the end instead.
    const maxPos = this.ctx.storage.sql.exec<{ maxpos: number | null }>("SELECT MAX(position) AS maxpos FROM room").one().maxpos;
    const pos = position ?? (maxPos ?? -1) + 1;
    const desc = description ?? null;
    this.ctx.storage.sql.exec(
      "INSERT INTO room (res_id, type, name, description, capabilities_json, restricted, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
      resId, type, name, desc, JSON.stringify(caps), restricted ? 1 : 0, pos, createdAt
    );
    const config = await this.getConfig();
    const restrictions = await this.getFeatureRestrictions();
    if (config && restrictions) {
      await this.env.ROOM_DO.getByName(`${config.id}/${typeToKind(type)}/${resId}`).setFeatureRestrictions(restrictions);
    }
    return { res_id: resId, type, name, description: desc, capabilities_json: JSON.stringify(caps), restricted: restricted ? 1 : 0, position: pos, archived: 0, created_at: createdAt };
  }

  async listRooms(): Promise<RoomRow[]> {
    try {
      return this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room WHERE archived = 0 ORDER BY position, created_at").toArray();
    } catch {
      return [];
    }
  }

  // Deletion must also purge archived rooms: their res_id is deliberately never
  // reused, but their RoomDO can still contain historical content.
  async listRoomsForDeletion(): Promise<RoomRow[]> {
    try {
      return this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room ORDER BY position, created_at").toArray();
    } catch {
      return [];
    }
  }

  // Called only by the HTTP deletion orchestrator after every child RoomDO has
  // been purged and the global D1 indexes have been removed.  deleteAll(), not
  // a table-by-table DELETE, is required to release Durable Object metadata.
  async purgeForStrongholdDeletion(): Promise<void> {
    for (const ws of this.ctx.getWebSockets("tips")) {
      try {
        ws.close(4000, "stronghold deleted");
      } catch {
        // A socket may have closed between enumeration and this call.
      }
    }
    await this.ctx.storage.deleteAll();
  }

  async getRoom(resId: string): Promise<RoomRow | null> {
    try {
      const rows = this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room WHERE res_id = ?", resId).toArray();
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  async updateRoom(
    resId: string,
    patch: { name?: string; description?: string | null; restricted?: boolean; position?: number; capabilities?: string[] }
  ): Promise<RoomRow | null> {
    const current = await this.getRoom(resId);
    if (!current) return null;
    const next = {
      ...current,
      name: patch.name ?? current.name,
      description: "description" in patch ? (patch.description ?? null) : current.description,
      restricted: patch.restricted != null ? (patch.restricted ? 1 : 0) : current.restricted,
      position: patch.position ?? current.position,
      capabilities_json: patch.capabilities ? JSON.stringify(patch.capabilities) : current.capabilities_json,
    };
    this.ctx.storage.sql.exec(
      "UPDATE room SET name = ?, description = ?, capabilities_json = ?, restricted = ?, position = ? WHERE res_id = ?",
      next.name, next.description, next.capabilities_json, next.restricted, next.position, resId
    );
    return next;
  }

  // proposal S3.6: room-ref res_id MUST NOT be recycled and next_seq MUST NOT reset,
  // so this only flags the room archived rather than deleting the row.
  async deleteRoom(resId: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE room SET archived = 1 WHERE res_id = ?", resId);
    this.ctx.storage.sql.exec("DELETE FROM tip WHERE room_ref LIKE ?", `%/${resId}`);
  }

  // ---- members --------------------------------------------------------------------
  // dev-only convenience for M1: no federation join_request flow yet (M6), so
  // membership is granted directly by an owner/mod through the API layer.

  async addMember(actor: string, role: Role = "member", deny = 0, restricted = false): Promise<MemberRow> {
    const joinedAt = Date.now();
    const effectiveDeny = role === "owner" || role === "mod" ? 0 : deny;
    this.ctx.storage.sql.exec(
      "INSERT INTO member (actor, role, deny, restricted, application_state, joined_at) VALUES (?, ?, ?, ?, 'approved', ?) " +
        "ON CONFLICT(actor) DO UPDATE SET role = excluded.role, deny = excluded.deny, restricted = excluded.restricted",
      actor, role, effectiveDeny, restricted ? 1 : 0, joinedAt
    );
    await this.indexMember(actor);
    const config = await this.getConfig();
    if (config) await this.syncDirectoryIndex(config);
    return { actor, role, deny: effectiveDeny, restricted: restricted ? 1 : 0, banned_at: null, expires_at: null, application_state: "approved", joined_at: joinedAt };
  }

  private clearExpiredBans(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE member SET banned_at = NULL, expires_at = NULL WHERE banned_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?",
      now
    );
    this.ctx.storage.sql.exec("DELETE FROM ban WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
  }

  async getMember(actor: string): Promise<MemberRow | null> {
    try {
      this.clearExpiredBans();
      const rows = this.ctx.storage.sql.exec<MemberRow>("SELECT * FROM member WHERE actor = ?", actor).toArray();
      if (rows[0]) return rows[0];
      return this.adoptLegacyActor(actor);
    } catch {
      return null;
    }
  }

  // The instance-domain migration (D1 0007) rewrote "@user:local" actors in D1
  // but per-DO SQLite rows were out of its reach, so strongholds created before
  // the domain was configured still key membership by the legacy actor. Lazily
  // rewrite every table that keys on the actor the first time the new-domain
  // actor shows up, then serve the row as if nothing happened.
  private adoptLegacyActor(actor: string): MemberRow | null {
    const m = /^@([^:]+):(.+)$/.exec(actor);
    if (!m || m[2] === "local") return null;
    const legacy = `@${m[1]}:local`;
    const rows = this.ctx.storage.sql.exec<MemberRow>("SELECT * FROM member WHERE actor = ?", legacy).toArray();
    if (!rows[0]) return null;
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE member SET actor = ? WHERE actor = ?", actor, legacy);
    sql.exec("UPDATE ban SET actor = ? WHERE actor = ?", actor, legacy);
    sql.exec("UPDATE config SET owner_actor = ? WHERE owner_actor = ?", actor, legacy);
    return { ...rows[0], actor };
  }

  async listMembers(): Promise<MemberRow[]> {
    try {
      this.clearExpiredBans();
      return this.ctx.storage.sql.exec<MemberRow>("SELECT * FROM member ORDER BY joined_at").toArray();
    } catch {
      return [];
    }
  }

  // Migration-era backfill for existing strongholds. It combines config and
  // SQL member counting into one DO call, then all later directory reads use D1.
  async hydrateDirectoryIndex(): Promise<boolean> {
    const config = await this.getConfig();
    if (!config) return false;
    await this.syncDirectoryIndex(config);
    return true;
  }

  // proposal §9: deny bits only apply to `member`; role/deny changes here never
  // touch `owner` (ownership moves only through transferOwnership). Caller (api.ts)
  // is responsible for the "role change requires owner" / "DENY_ON_MOD" gating -
  // this just applies whatever role/deny the caller already validated.
  async updateMember(actor: string, patch: { role?: "mod" | "member"; deny?: number }): Promise<MemberRow | null> {
    const current = await this.getMember(actor);
    if (!current || current.role === "owner") return null;
    const role = patch.role ?? current.role;
    const deny = role === "mod" ? 0 : patch.deny ?? current.deny;
    this.ctx.storage.sql.exec("UPDATE member SET role = ?, deny = ? WHERE actor = ?", role, deny, actor);
    await this.revokeActor(actor);
    return { ...current, role, deny };
  }

  // Kick: revocable removal, the row is gone entirely (distinct from ban, which
  // keeps the row and sets banned_at - see banMember). Never targets `owner`.
  async removeMember(actor: string): Promise<boolean> {
    const current = await this.getMember(actor);
    if (!current || current.role === "owner") return false;
    this.ctx.storage.sql.exec("DELETE FROM member WHERE actor = ?", actor);
    await this.unindexMember(actor);
    const config = await this.getConfig();
    if (config) await this.syncDirectoryIndex(config);
    await this.pushRevokeToRooms({ actor, scope: this.selfId, effect: "close" });
    return true;
  }

  async transferOwnership(fromActor: string, toActor: string): Promise<ConfigRow | null> {
    const config = await this.getConfig();
    const target = await this.getMember(toActor);
    if (!config || config.owner_actor !== fromActor || !target || target.role === "owner") return null;
    this.ctx.storage.sql.exec("UPDATE member SET role = 'owner', deny = 0 WHERE actor = ?", toActor);
    this.ctx.storage.sql.exec("UPDATE member SET role = 'member', deny = 0 WHERE actor = ?", fromActor);
    this.ctx.storage.sql.exec("UPDATE config SET owner_actor = ? WHERE id = ?", toActor, config.id);
    // Both actors' live attachments still carry the pre-transfer roles
    // (m0-protocol §7.3) - the demotion matters for enforcement, the promotion
    // is pushed for symmetry so a reconnect is never needed to pick it up.
    await Promise.all([this.revokeActor(fromActor), this.revokeActor(toActor)]);
    return { ...config, owner_actor: toActor };
  }

  // ---- bans (audit trail; member.banned_at stays the fast-path gate check) --------

  async banMember(actor: string, operator: string, expiresAt: number | null = null): Promise<MemberRow | null> {
    const target = await this.getMember(actor);
    if (!target || target.role === "owner") return null;
    const bannedAt = Date.now();
    this.ctx.storage.sql.exec("UPDATE member SET banned_at = ?, expires_at = ? WHERE actor = ?", bannedAt, expiresAt, actor);
    this.ctx.storage.sql.exec(
      "INSERT INTO ban (actor, operator, banned_at, expires_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(actor) DO UPDATE SET operator = excluded.operator, banned_at = excluded.banned_at, expires_at = excluded.expires_at",
      actor, operator, bannedAt, expiresAt
    );
    await this.pushRevokeToRooms({ actor, scope: this.selfId, effect: "close" });
    return { ...target, banned_at: bannedAt, expires_at: expiresAt };
  }

  async unbanMember(actor: string): Promise<MemberRow | null> {
    const target = await this.getMember(actor);
    this.ctx.storage.sql.exec("UPDATE member SET banned_at = NULL, expires_at = NULL WHERE actor = ?", actor);
    this.ctx.storage.sql.exec("DELETE FROM ban WHERE actor = ?", actor);
    return target ? { ...target, banned_at: null, expires_at: null } : null;
  }

  async listBans(): Promise<BanRow[]> {
    this.clearExpiredBans();
    return this.ctx.storage.sql.exec<BanRow>("SELECT * FROM ban ORDER BY banned_at DESC").toArray();
  }

  // ---- tips (S3.3 / S4.4) -----------------------------------------------------------

  // Called by RoomDO after each commit. Absolute + idempotent: only advances.
  async reportTip(roomRef: string, latestSeq: number): Promise<void> {
    const ts = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO tip (room_ref, latest_seq, ts) VALUES (?, ?, ?) " +
        "ON CONFLICT(room_ref) DO UPDATE SET latest_seq = excluded.latest_seq, ts = excluded.ts " +
        "WHERE excluded.latest_seq > tip.latest_seq",
      roomRef, latestSeq, ts
    );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm == null) {
      await this.ctx.storage.setAlarm(Date.now() + TIP_FLUSH_MS);
    }
  }

  async getTips(): Promise<{ room_ref: string; latest_seq: number; ts: number }[]> {
    return this.ctx.storage.sql.exec<{ room_ref: string; latest_seq: number; ts: number }>("SELECT * FROM tip").toArray();
  }

  private async getTipsForRole(role: Role): Promise<{ room_ref: string; latest_seq: number; ts: number }[]> {
    const tips = await this.getTips();
    if (role === "owner" || role === "mod") return tips;
    const restricted = new Set(
      (await this.listRooms())
        .filter((room) => Boolean(room.restricted))
        .map((room) => `${this.selfId}/${typeToKind(room.type)}/${room.res_id}`)
    );
    return tips.filter((tip) => !restricted.has(tip.room_ref));
  }

  async alarm(): Promise<void> {
    const tips = await this.getTips();
    const restricted = new Set(
      (await this.listRooms())
        .filter((room) => Boolean(room.restricted))
        .map((room) => `${this.selfId}/${typeToKind(room.type)}/${room.res_id}`)
    );
    for (const ws of this.ctx.getWebSockets("tips")) {
      const attachment = ws.deserializeAttachment() as TipAttachment | null;
      const entries = attachment && (attachment.role === "owner" || attachment.role === "mod")
        ? tips
        : tips.filter((tip) => !restricted.has(tip.room_ref));
      try {
        ws.send(JSON.stringify({ type: "tip.update", entries }));
      } catch {
        continue;
      }
    }
  }

  // ---- tips WS ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
    if (!protocolHeader) {
      return new Response("missing token", { status: 401 });
    }
    const token = protocolHeader.trim();
    const claims = await verifyToken<StrongholdTokenClaims>(token, this.env.DEV_TOKEN_SECRET);
    if (!claims || claims.typ !== "stronghold" || claims.stronghold !== this.selfId) {
      return new Response("invalid token", { status: 401 });
    }
    if (!await this.getConfig()) return new Response("stronghold not found", { status: 404 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["tips"]);
    const attachment: TipAttachment = { actor: claims.actor, stronghold: claims.stronghold, role: claims.role };
    server.serializeAttachment(attachment);

    // First-frame snapshot so a freshly (re)connected client doesn't wait for the
    // next coalesced flush to see current unread state.
    const tips = await this.getTipsForRole(claims.role);
    server.send(JSON.stringify({ type: "tip.update", entries: tips }));

    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": token } });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // Reserved codes (e.g. 1005, reported when the client closed without one)
      // MUST NOT be echoed back explicitly - fall back to a plain close.
      ws.close(code, reason);
    } catch {
      ws.close();
    }
  }

  async webSocketError(): Promise<void> {
    // nothing durable to clean up.
  }

  async webSocketMessage(): Promise<void> {
    // tips channel is push-only in M1; client frames are ignored.
  }
}
