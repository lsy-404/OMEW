import { env } from "cloudflare:test";
import worker from "../server/src/api";
import { signToken } from "../server/src/auth";
import { instanceDomain, type Role, type RoomTokenClaims, type ServerRole, type SessionTokenClaims, type StrongholdTokenClaims } from "../server/src/types";
import { domainOfActor, localpartOfActor } from "../server/src/users";
import migration0001 from "../server/migrations/0001_init.sql?raw";
import migration0002 from "../server/migrations/0002_user_system.sql?raw";
import migration0003 from "../server/migrations/0003_stronghold_index.sql?raw";
import migration0004 from "../server/migrations/0004_media.sql?raw";
import migration0005 from "../server/migrations/0005_emotes.sql?raw";
import migration0006 from "../server/migrations/0006_governance.sql?raw";
import migration0007 from "../server/migrations/0007_guest_domain.sql?raw";
import migration0008 from "../server/migrations/0008_server_role.sql?raw";
import migration0009 from "../server/migrations/0009_server_groups.sql?raw";
import migration0010 from "../server/migrations/0010_totp_passkey.sql?raw";
import migration0011 from "../server/migrations/0011_totp_passkey_hardening.sql?raw";
import migration0012 from "../server/migrations/0012_stronghold_slug.sql?raw";
import migration0013 from "../server/migrations/0013_security_hardening.sql?raw";
import migration0014 from "../server/migrations/0014_user_avatar.sql?raw";
import migration0015 from "../server/migrations/0015_timed_bans.sql?raw";
import migration0016 from "../server/migrations/0016_stronghold_feature_overrides.sql?raw";
import migration0017 from "../server/migrations/0017_stronghold_directory_index.sql?raw";
import migration0018 from "../server/migrations/0018_user_cover.sql?raw";
import migration0019 from "../server/migrations/0019_user_last_active.sql?raw";
import migration0020Bio from "../server/migrations/0020_user_bio.sql?raw";
import migration0021Messaging from "../server/migrations/0021_direct_messages_blocks.sql?raw";
import migration0022Oidc from "../server/migrations/0022_oidc_sso.sql?raw";

// Must match vitest.config.ts's miniflare.bindings.DEV_TOKEN_SECRET.
export const TEST_SECRET = "test-secret-do-not-use-in-prod";

// vitest.config.ts doesn't wire up the usual readD1Migrations/applyD1Migrations
// setup (that needs a Node-side config change, out of scope for /test), so tests
// that touch D1 apply the migration files themselves - once per worker instance.
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureMigrated(): Promise<void> {
  // Existing API fixtures create temporary strongholds freely; production's
  // deployment default is restricted and policy tests override this explicitly.
  env.STRONGHOLD_CREATION = "open";
  env.STRONGHOLD_CREATORS = "";
  const marker = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instance_config'"
  ).first();
  const directoryProjection = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stronghold_directory_index'"
  ).first();
  const userColumns = marker ? await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>() : null;
  const hasCover = userColumns?.results.some((column) => column.name === "cover") ?? false;
  const hasLastActive = userColumns?.results.some((column) => column.name === "last_active_at") ?? false;
  const hasBio = userColumns?.results.some((column) => column.name === "bio") ?? false;
  const directMessages = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direct_messages'"
  ).first();
  const oidcIdentities = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oidc_identities'"
  ).first();
  if (marker && directoryProjection && hasCover && hasLastActive && hasBio && directMessages && oidcIdentities) return;
  if (marker) {
    if (!directoryProjection) {
      for (const statement of splitStatements(migration0017)) await env.DB.prepare(statement).run();
    }
    if (!hasCover) for (const statement of splitStatements(migration0018)) await env.DB.prepare(statement).run();
    if (!hasLastActive) for (const statement of splitStatements(migration0019)) await env.DB.prepare(statement).run();
    if (!hasBio) for (const statement of splitStatements(migration0020Bio)) await env.DB.prepare(statement).run();
    if (!directMessages) for (const statement of splitStatements(migration0021Messaging)) await env.DB.prepare(statement).run();
    if (!oidcIdentities) for (const statement of splitStatements(migration0022Oidc)) await env.DB.prepare(statement).run();
    return;
  }
  for (const sql of [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006, migration0007, migration0008, migration0009, migration0010, migration0011, migration0012, migration0013, migration0014, migration0015, migration0016, migration0017, migration0018, migration0019, migration0020Bio, migration0021Messaging, migration0022Oidc]) {
    for (const statement of splitStatements(sql)) {
      await env.DB.prepare(statement).run();
    }
  }
}

export function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return worker.fetch(new Request(`http://local${path}`, { ...init, headers }), env);
}

// Raw-body upload for POST /api/media - callers control Content-Type and
// Content-Length explicitly, including declaring a length that doesn't match the
// stream's actual byte count (to exercise the streaming length-mismatch guard).
export function mediaUploadRequest(opts: {
  token: string;
  contentType: string;
  declaredLength: number | null;
  body: Uint8Array | ReadableStream<Uint8Array>;
}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": opts.contentType,
  };
  if (opts.declaredLength !== null) headers["Content-Length"] = String(opts.declaredLength);
  return worker.fetch(
    new Request("http://local/api/media", {
      method: "POST",
      headers,
      body: opts.body,
      duplex: opts.body instanceof ReadableStream ? "half" : undefined,
    } as RequestInit),
    env
  );
}

export function avatarUploadRequest(opts: {
  token?: string;
  contentType: string;
  body: Uint8Array;
}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Content-Length": String(opts.body.byteLength),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return worker.fetch(
    new Request("http://local/api/me/avatar", {
      method: "POST",
      headers,
      body: opts.body,
    }),
    env
  );
}

export function coverUploadRequest(opts: {
  token?: string;
  contentType: string;
  body: Uint8Array;
}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Content-Length": String(opts.body.byteLength),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return worker.fetch(new Request("http://local/api/me/cover", { method: "POST", headers, body: opts.body }), env);
}

export async function registerUser(
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await apiRequest("/api/register", { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// server_role rides in the session token claim (m0-protocol §7.10) - a token
// minted before a D1 server_role promotion won't reflect it, so tests that
// promote a user directly via D1 (there's no other way to mint an owner in a
// test) need a fresh token afterwards to actually exercise the new role.
export async function loginAs(username: string, password = "password123"): Promise<string> {
  const res = await apiRequest("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function connectRoom(
  roomRef: string,
  actor: string,
  role: Role = "owner",
  deny = 0
): Promise<{ ws: WebSocket; stub: DurableObjectStub<import("../server/src/room-do").RoomDO> }> {
  const claims: RoomTokenClaims = {
    v: 1,
    typ: "room",
    actor,
    room: roomRef,
    role,
    deny,
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
  };
  const token = await signToken(claims, TEST_SECRET);
  const stub = env.ROOM_DO.getByName(roomRef);
  const res = await stub.fetch("http://do/ws", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": token },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("handshake did not return a websocket");
  ws.accept();
  return { ws, stub };
}

// Stronghold-level tips WS (m0-protocol §10.6) - mirrors connectRoom, but with a
// stronghold-scoped token against StrongholdDO.fetch. The server sends a
// tip.update snapshot as its first frame on every fresh connection.
export async function connectTips(
  strongholdId: string,
  actor: string,
  role: Role = "member"
): Promise<{
  ws: WebSocket;
  stub: DurableObjectStub<import("../server/src/stronghold-do").StrongholdDO>;
  firstMessage: Promise<Record<string, unknown>>;
}> {
  const claims: StrongholdTokenClaims = {
    v: 1,
    typ: "stronghold",
    actor,
    stronghold: strongholdId,
    role,
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
  };
  const token = await signToken(claims, TEST_SECRET);
  const stub = env.STRONGHOLD_DO.getByName(strongholdId);
  const res = await stub.fetch("http://do/ws", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": token },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("handshake did not return a websocket");
  const firstMessage = nextMessage(ws);
  ws.accept();
  return { ws, stub, firstMessage };
}

export function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    ws.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true }
    );
  });
}

export function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 5000);
    const handler = (event: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(event.data as string));
    };
    ws.addEventListener("message", handler);
  });
}

// Drains messages off `ws` until one of the given `type` arrives, discarding any
// interleaved frames of other types along the way. batch (item.create/update/
// delete) and item.bump are independent broadcast paths with no ordering
// guarantee relative to each other, so tests can't assume a fixed arrival order.
export async function nextMessageOfType(ws: WebSocket, type: string, maxDrain = 10): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxDrain; i++) {
    const msg = await nextMessage(ws);
    if (msg.type === type) return msg;
  }
  throw new Error(`no message of type ${type} seen within ${maxDrain} messages`);
}

// Collects every message that arrives within `ms`, then resolves with all of
// them - used to assert on the absence/presence of a given frame type over a
// window, without assuming anything about interleaving with other frame types.
export function collectMessagesFor(ws: WebSocket, ms: number): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      messages.push(JSON.parse(event.data as string));
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(messages);
    }, ms);
  });
}

export function itemCreateFrame(clientId: string, text: string): string {
  return JSON.stringify({ type: "item.create", client_id: clientId, kind: "post", body: { text } });
}

// Section-real: a top-level section item MUST be a titled post; a channel post
// MUST NOT carry a title (see room-do.ts's channel/section kind matrix).
export function postCreateFrame(clientId: string, title: string, text: string, cover?: string): string {
  return JSON.stringify({ type: "item.create", client_id: clientId, kind: "post", body: { title, text, ...(cover ? { cover } : {}) } });
}

export function replyCreateFrame(clientId: string, parentSeq: number, text: string): string {
  return JSON.stringify({ type: "item.create", client_id: clientId, kind: "reply", parent_seq: parentSeq, body: { text } });
}

export function itemUpdateFrame(targetSeq: number, text: string): string {
  return JSON.stringify({ type: "item.update", target_seq: targetSeq, body: { text } });
}

export function itemDeleteFrame(targetSeq: number, reason?: string): string {
  return JSON.stringify({ type: "item.delete", target_seq: targetSeq, reason });
}

export function itemReactionFrame(targetSeq: number, name: string, op: "add" | "remove"): string {
  return JSON.stringify({ type: "item.reaction", target_seq: targetSeq, name, op });
}

// Mints a bearer session token directly (bypasses /api/register + D1) - mirrors
// connectRoom's direct RoomTokenClaims signing, for tests that only care about
// StrongholdDO/RoomDO authorization mechanics rather than the full user system.
// Defaults to server_role "user" (no §7.10 overlay) so existing per-stronghold
// role tests keep exercising real membership; pass "admin"/"owner" to test the
// overlay explicitly.
export async function sessionToken(actor: string, serverRole: ServerRole = "user"): Promise<string> {
  if (domainOfActor(actor) === instanceDomain(env)) {
    await ensureMigrated();
    const localpart = localpartOfActor(actor);
    await env.DB.prepare(
      "INSERT INTO users (localpart, display_name, status, created_at, server_role) VALUES (?, ?, 'active', ?, ?) " +
        "ON CONFLICT(localpart) DO UPDATE SET status = 'active', server_role = excluded.server_role"
    )
      .bind(localpart, localpart, Date.now(), serverRole)
      .run();
  }
  const claims: SessionTokenClaims = {
    v: 1,
    typ: "session",
    actor,
    server_role: serverRole,
    auth_source: "local",
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
  };
  return signToken(claims, TEST_SECRET);
}
