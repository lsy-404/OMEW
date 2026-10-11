import { base64UrlEncode, signToken } from "./auth";
import { getInstanceConfig } from "./config";
import { instanceDomain, type SessionTokenClaims } from "./types";
import { isOriginTrusted } from "./users";
import {
  boundedJson,
  canonicalActor,
  canonicalDomain,
  canonicalRoom,
  domain,
  Envelope,
  failure,
  FRESH_MS,
  object,
  ProtocolError,
  protocolResponse,
  QUEUE_MS,
  RETENTION_MS,
  uuidV7,
  verifyObject,
  type JsonObject,
} from "./federation-codec";
import {
  assertPeer,
  configuredPeer,
  discoverPeer,
  ownKeys,
  peerFetch,
  signDocument,
  verifyPeerDocument,
} from "./federation-keys";
import { localProfile, upsertGuestProfile } from "./federation-profiles";

const EVENT_TYPES = new Set([
  "item.create",
  "item.update",
  "item.delete",
  "item.bump",
  "tip.digest",
  "tip.mention",
  "member.update",
  "member.ban",
  "member.join_request",
  "member.join_approved",
  "member.join_rejected",
  "stronghold.update",
  "stronghold.room.create",
  "stronghold.room.update",
  "stronghold.room.delete",
  "user.update",
  "user.deactivate",
  "user.link",
  "user.link_confirm",
  "user.unlink",
  "user.moved",
  "user.move_objection",
]);
export interface Delivery {
  peer: string;
  envelope: Envelope;
}
export async function rateLimit(
  env: Env,
  bucket: string,
  maximum = 120,
): Promise<void> {
  const window = Math.floor(Date.now() / 60_000);
  const row = await env.DB.prepare(
    "INSERT INTO federation_rate(bucket,window,count) VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count",
  )
    .bind(bucket, window)
    .first<{ count: number }>();
  if (row!.count > maximum) throw new ProtocolError(429, "OMEW_RATE_LIMITED");
}
export async function newEvent(
  env: Env,
  type: string,
  payload: JsonObject,
  context: {
    actor?: string;
    room?: string;
    seq?: number;
    id?: string;
    ts?: number;
  } = {},
): Promise<Envelope> {
  return (await signDocument(env, "openmew/event/v1", {
    v: 1,
    id: context.id ?? uuidV7(),
    type,
    origin: instanceDomain(env),
    ts: context.ts ?? Date.now(),
    payload,
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.room ? { room: context.room } : {}),
    ...(context.seq !== undefined ? { seq: context.seq } : {}),
  })) as Envelope;
}
export async function queueDelivery(
  env: Env,
  peer: string,
  envelope: Envelope,
): Promise<void> {
  await assertPeer(env, peer);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_delivery(id,peer,envelope,next_attempt,expires_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      envelope.id,
      peer,
      JSON.stringify(envelope),
      Date.now(),
      Date.now() + QUEUE_MS,
    )
    .run();
  await env.FEDERATION_OUT.send({ peer, envelope } satisfies Delivery);
}
export async function signedRequestHeaders(
  env: Env,
  method: string,
  path: string,
  actor: string,
): Promise<Headers> {
  const target = new URL(path, "https://request.invalid");
  const doc = await signDocument(env, "openmew/request/v1", {
    method,
    path: target.pathname,
    query: target.search.slice(1),
    origin: instanceDomain(env),
    on_behalf_of: actor,
    ts: Date.now(),
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  });
  return new Headers({
    Authorization: `OpenMew key_id=${doc.key_id},ts=${doc.ts},nonce=${doc.nonce},on_behalf_of=${encodeURIComponent(actor)},sig=${doc.sig}`,
    "OMEW-Origin": instanceDomain(env),
    "Content-Type": "application/json",
  });
}
export async function verifyRequest(
  env: Env,
  request: Request,
): Promise<{ origin: string; actor: string }> {
  const origin = request.headers.get("OMEW-Origin") ?? "";
  await assertPeer(env, origin);
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("OpenMew "))
    throw new ProtocolError(403, "OMEW_BAD_SIGNATURE");
  const fields = Object.fromEntries(
    auth
      .slice(8)
      .split(",")
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), part.slice(index + 1)];
      }),
  );
  let actor: string;
  try {
    actor = decodeURIComponent(fields.on_behalf_of ?? "");
  } catch {
    throw new ProtocolError(400, "OMEW_MALFORMED");
  }
  const time = Number(fields.ts);
  const nonce = fields.nonce ?? "";
  if (!canonicalActor(actor) || domain(actor) !== origin)
    throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > FRESH_MS)
    throw new ProtocolError(400, "OMEW_STALE_TS");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce))
    throw new ProtocolError(400, "OMEW_MALFORMED");
  const url = new URL(request.url);
  await verifyPeerDocument(
    env,
    "openmew/request/v1",
    {
      method: request.method,
      path: url.pathname,
      query: url.search.slice(1),
      origin,
      on_behalf_of: actor,
      ts: time,
      nonce,
      key_id: fields.key_id,
      sig: fields.sig,
    },
    origin,
  );
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_seen(origin,id,expires_at) VALUES (?,?,?) RETURNING id",
  )
    .bind(origin, `request:${nonce}`, Date.now() + RETENTION_MS)
    .first();
  if (!inserted) throw new ProtocolError(409, "OMEW_ASSERTION_REPLAY");
  return { origin, actor };
}
export async function verifyEnvelope(
  env: Env,
  value: unknown,
  historical = false,
): Promise<Envelope> {
  if (
    !object(value) ||
    value.v !== 1 ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !canonicalDomain(value.origin) ||
    typeof value.type !== "string" ||
    !object(value.payload) ||
    !Number.isSafeInteger(value.ts)
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65_536)
    throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
  await assertPeer(env, value.origin);
  if (!historical && Math.abs(Date.now() - Number(value.ts)) > FRESH_MS)
    throw new ProtocolError(400, "OMEW_STALE_TS");
  if (historical) {
    const key = await env.DB.prepare(
      "SELECT public_key FROM instance_keys WHERE instance=? AND key_id=?",
    )
      .bind(value.origin, String(value.key_id))
      .first<{ public_key: string }>();
    if (
      !key ||
      !(await verifyObject("openmew/event/v1", value, key.public_key))
    )
      throw new ProtocolError(403, "OMEW_BAD_SIGNATURE");
  } else await verifyPeerDocument(env, "openmew/event/v1", value, value.origin);
  const event = value as Envelope;
  if (event.actor && !canonicalActor(event.actor))
    throw new ProtocolError(400, "OMEW_NOT_CANONICAL");
  if (event.room && !canonicalRoom(event.room))
    throw new ProtocolError(400, "OMEW_NOT_CANONICAL");
  if (
    event.seq !== undefined &&
    (!Number.isSafeInteger(event.seq) || event.seq < 1)
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (event.type.startsWith("user.") || event.type === "member.join_request") {
    if (event.room || event.seq !== undefined)
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (event.type === "user.link_confirm" || event.type === "user.unlink") {
      if (
        event.actor ||
        typeof event.payload.subject !== "string" ||
        domain(event.payload.subject) !== instanceDomain(env) ||
        !(await env.DB.prepare(
          "SELECT actor FROM user_link WHERE actor=? AND peer_instance=?",
        )
          .bind(event.payload.subject, event.origin)
          .first())
      )
        throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
    } else if (!event.actor || domain(event.actor) !== event.origin)
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
  } else if (event.type.startsWith("item.") || event.type === "tip.mention") {
    if (
      !event.room ||
      !(await env.DB.prepare(
        "SELECT origin FROM federation_rooms WHERE origin=? AND room=? AND visibility='public'",
      )
        .bind(event.origin, event.room)
        .first())
    )
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
  }
  return event;
}
export async function applyRoomEvents(
  env: Env,
  peer: string,
  room: string,
): Promise<void> {
  const state = await env.DB.prepare(
    "SELECT high_water FROM federation_rooms WHERE origin=? AND room=?",
  )
    .bind(peer, room)
    .first<{ high_water: number }>();
  if (!state) return;
  const { results } = await env.DB.prepare(
    "SELECT seq,r2_key FROM federation_events WHERE origin=? AND room=? AND seq>? ORDER BY seq LIMIT 200",
  )
    .bind(peer, room, state.high_water)
    .all<{ seq: number; r2_key: string }>();
  let water = state.high_water;
  const statements: D1PreparedStatement[] = [];
  for (const row of results) {
    if (row.seq !== water + 1) break;
    const stored = await env.MEDIA.get(row.r2_key);
    if (!stored) throw new ProtocolError(503, "OMEW_SEQ_GAP");
    const event = await stored.json<Envelope>();
    const p = event.payload;
    if (event.type === "item.create") {
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO federation_items(origin,room,seq,parent_seq,root_seq,actor,kind,ts,r2_key) VALUES (?,?,?,?,?,?,?,?,?)",
        ).bind(
          peer,
          room,
          event.seq,
          p.parent_seq ?? null,
          p.parent_seq ?? event.seq,
          event.actor ?? "",
          p.kind,
          p.created_at ?? event.ts,
          row.r2_key,
        ),
      );
    } else if (event.type === "item.update") {
      statements.push(
        env.DB.prepare(
          "UPDATE federation_items SET edit_key=?,edit_seq=? WHERE origin=? AND room=? AND seq=? AND edit_seq<? AND deleted=0",
        ).bind(row.r2_key, event.seq, peer, room, p.target_seq, event.seq),
      );
    } else if (event.type === "item.delete") {
      statements.push(
        env.DB.prepare(
          "UPDATE federation_items SET deleted=1 WHERE origin=? AND room=? AND seq=?",
        ).bind(peer, room, p.target_seq),
      );
    }
    water = row.seq;
  }
  if (water > state.high_water) {
    statements.push(
      env.DB.prepare(
        "UPDATE federation_rooms SET high_water=MAX(high_water,?) WHERE origin=? AND room=?",
      ).bind(water, peer, room),
    );
    await env.DB.batch(statements);
  }
}
export async function acceptEnvelope(
  env: Env,
  event: Envelope,
): Promise<string> {
  if (
    !EVENT_TYPES.has(event.type) ||
    event.type === "item.reaction" ||
    (event.type === "item.create" &&
      !["post", "reply"].includes(String(event.payload.kind)))
  )
    return "ignored";
  if (event.type === "item.bump") {
    if (
      event.seq !== undefined ||
      !event.room ||
      !Number.isSafeInteger(event.payload.post_seq) ||
      !Number.isSafeInteger(event.payload.last_reply_seq) ||
      !Number.isSafeInteger(event.payload.reply_count)
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await env.DB.prepare(
      "INSERT INTO federation_ephemeral(origin,room,type,target,version,envelope) VALUES (?,?,?,?,?,?) ON CONFLICT(origin,room,type,target) DO UPDATE SET version=excluded.version,envelope=excluded.envelope WHERE excluded.version>version",
    )
      .bind(
        event.origin,
        event.room,
        event.type,
        event.payload.post_seq,
        event.payload.last_reply_seq,
        JSON.stringify(event),
      )
      .run();
    return "accepted";
  }
  if (
    await env.DB.prepare(
      "SELECT id FROM federation_seen WHERE origin=? AND id=?",
    )
      .bind(event.origin, event.id)
      .first()
  )
    return "duplicate";
  const statements: D1PreparedStatement[] = [];
  if (event.type.startsWith("item.")) {
    if (
      !event.room ||
      !event.seq ||
      (!object(event.payload.body) && event.type !== "item.delete")
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    const mapping = await env.DB.prepare(
      "SELECT high_water FROM federation_rooms WHERE origin=? AND room=?",
    )
      .bind(event.origin, event.room)
      .first<{ high_water: number }>();
    if (event.seq > mapping!.high_water + 200)
      throw new ProtocolError(409, "OMEW_SEQ_GAP");
    const r2Key = `federation/${event.origin}/${event.room}/${event.seq}.json`;
    await env.MEDIA.put(r2Key, JSON.stringify(event), {
      httpMetadata: { contentType: "application/json" },
    });
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO federation_events(origin,room,seq,r2_key,received_at) VALUES (?,?,?,?,?)",
      ).bind(event.origin, event.room, event.seq, r2Key, Date.now()),
    );
  } else if (event.type === "user.link_confirm") {
    statements.push(
      env.DB.prepare(
        "UPDATE user_link SET state='confirmed',confirmed_at=? WHERE actor=? AND peer_instance=?",
      ).bind(Date.now(), event.payload.subject, event.origin),
    );
  } else if (event.type === "user.unlink") {
    statements.push(
      env.DB.prepare(
        "DELETE FROM user_link WHERE actor=? AND peer_instance=?",
      ).bind(event.payload.subject, event.origin),
    );
  } else if (event.type === "user.deactivate") {
    statements.push(
      env.DB.prepare(
        "UPDATE guest_identity SET profile_status='deactivated',sessions_revoked_at=? WHERE actor=? AND registered_origin=?",
      ).bind(Date.now(), event.actor, event.origin),
    );
    statements.push(
      env.DB.prepare("DELETE FROM federation_sessions WHERE actor=?").bind(
        event.actor,
      ),
    );
  } else if (event.type === "user.update") {
    const existing = await env.DB.prepare(
      "SELECT actor FROM guest_identity WHERE actor=?",
    )
      .bind(event.actor)
      .first();
    if (existing)
      await upsertGuestProfile(
        env,
        { actor: event.actor, status: "active", ...event.payload },
        event.origin,
      );
  } else if (
    event.type === "user.moved" ||
    event.type === "user.move_objection"
  ) {
    const { acceptMigrationAnnouncement } = await import("./account-migration");
    await acceptMigrationAnnouncement(env, event);
  } else if (
    event.type === "stronghold.update" &&
    event.payload.visibility === "private"
  ) {
    statements.push(
      env.DB.prepare(
        "UPDATE federation_rooms SET visibility='private' WHERE origin=? AND room LIKE ?",
      ).bind(event.origin, `${event.payload.stronghold}/%`),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO federation_seen(origin,id,expires_at) VALUES (?,?,?)",
    ).bind(event.origin, event.id, Date.now() + RETENTION_MS),
  );
  await env.DB.batch(statements);
  if (event.type.startsWith("item.") && event.room)
    await applyRoomEvents(env, event.origin, event.room);
  if (event.type === "user.deactivate" && event.actor)
    await revokeGuest(env, event.actor);
  return "accepted";
}
export async function handleFederationInbox(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    if (request.method !== "POST")
      throw new ProtocolError(405, "OMEW_METHOD_NOT_ALLOWED");
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    const maximum =
      new URL(request.url).pathname === "/inbox" ? 65536 : 1_048_576;
    if (declared > maximum)
      throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
    await rateLimit(
      env,
      `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    );
    const parsed = await boundedJson(request, maximum);
    const batch =
      object(parsed) && Array.isArray(parsed.batch) ? parsed.batch : [parsed];
    if (batch.length === 0 || batch.length > 100)
      throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
    const receipts: JsonObject[] = [];
    for (const entry of batch) {
      if (object(entry) && typeof entry.origin === "string")
        await rateLimit(env, `origin:${entry.origin}`, 600);
      const event = await verifyEnvelope(env, entry);
      receipts.push({
        id: event.id,
        status: await acceptEnvelope(env, event),
        ...(event.seq ? { seq: event.seq } : {}),
      });
    }
    return protocolResponse({ receipts }, 202);
  } catch (error) {
    return failure(error);
  }
}
export async function exchangeFederationSession(
  request: Request,
  env: Env,
): Promise<Response> {
  await rateLimit(
    env,
    `session:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    30,
  );
  const assertion = await boundedJson(request);
  if (
    !object(assertion) ||
    assertion.v !== 1 ||
    assertion.typ !== "openmew.assertion.v1" ||
    !canonicalDomain(assertion.iss) ||
    !canonicalActor(assertion.sub) ||
    domain(assertion.sub) !== assertion.iss
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (assertion.aud !== instanceDomain(env))
    throw new ProtocolError(403, "OMEW_AUDIENCE_MISMATCH");
  if (!isOriginTrusted(getInstanceConfig(env), assertion.iss))
    throw new ProtocolError(403, "OMEW_ORIGIN_NOT_TRUSTED");
  await verifyPeerDocument(
    env,
    "openmew/assertion/v1",
    assertion,
    assertion.iss,
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(assertion.iat) ||
    !Number.isSafeInteger(assertion.exp) ||
    Number(assertion.exp) <= now ||
    Number(assertion.iat) > now + 300 ||
    Number(assertion.exp) - Number(assertion.iat) > 300 ||
    Number(assertion.exp) <= Number(assertion.iat) ||
    typeof assertion.jti !== "string" ||
    assertion.jti.length > 128
  )
    throw new ProtocolError(400, "OMEW_STALE_TS");
  const current = await env.DB.prepare(
    "SELECT profile_status FROM guest_identity WHERE actor=?",
  )
    .bind(assertion.sub)
    .first<{ profile_status: string }>();
  if (
    current?.profile_status === "deactivated" ||
    (await env.DB.prepare(
      "SELECT new_actor FROM actor_aliases WHERE old_actor=?",
    )
      .bind(assertion.sub)
      .first())
  )
    throw new ProtocolError(403, "OMEW_ACTOR_DEACTIVATED");
  const profileResponse = await peerFetch(
    env,
    assertion.iss,
    `/.well-known/openmew/users/${encodeURIComponent(assertion.sub.slice(1, assertion.sub.indexOf(":")))}`,
  );
  if (!profileResponse.ok)
    throw new ProtocolError(403, "OMEW_ACTOR_DEACTIVATED");
  const profile = await boundedJson(profileResponse);
  if (
    !object(profile) ||
    profile.actor !== assertion.sub ||
    profile.status !== "active" ||
    Number(profile.profile_version) < Number(assertion.profile_version)
  )
    throw new ProtocolError(403, "OMEW_ACTOR_DEACTIVATED");
  await verifyPeerDocument(
    env,
    "openmew/user-profile/v1",
    profile,
    assertion.iss,
  );
  const used = await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_assertions(origin,jti,expires_at) VALUES (?,?,?) RETURNING jti",
  )
    .bind(
      assertion.iss,
      assertion.jti,
      Number(assertion.exp) * 1000 + 2 * FRESH_MS,
    )
    .first();
  if (!used) throw new ProtocolError(409, "OMEW_ASSERTION_REPLAY");
  await upsertGuestProfile(env, profile, assertion.iss);
  const claims: SessionTokenClaims = {
    v: 1,
    typ: "session",
    actor: assertion.sub,
    server_role: "user",
    auth_source: "federation",
    iat: now,
    exp: now + 86400,
    jti: crypto.randomUUID(),
  };
  const token = await signToken(claims, env.DEV_TOKEN_SECRET);
  await env.DB.prepare(
    "INSERT INTO federation_sessions(jti,actor,issued_at,expires_at) VALUES (?,?,?,?)",
  )
    .bind(claims.jti, claims.actor, Date.now(), claims.exp * 1000)
    .run();
  await queueDelivery(
    env,
    assertion.iss,
    await newEvent(env, "user.link_confirm", {
      subject: assertion.sub,
      first_seen_at: Date.now(),
    }),
  );
  return protocolResponse({
    token,
    actor: claims.actor,
    guest: true,
    exp: claims.exp,
    instance: instanceDomain(env),
  });
}
export async function issueFederationAssertion(
  env: Env,
  actor: string,
  peer: string,
): Promise<JsonObject> {
  await assertPeer(env, peer);
  if (domain(actor) !== instanceDomain(env))
    throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
  const profile = await localProfile(env, actor);
  const now = Math.floor(Date.now() / 1000);
  if (profile.status !== "active" || profile.moved_to)
    throw new ProtocolError(403, "OMEW_ACTOR_DEACTIVATED");
  await env.DB.prepare(
    "INSERT INTO user_link(actor,peer_instance,state,created_at) VALUES (?,?,'pending',?) ON CONFLICT(actor,peer_instance) DO UPDATE SET state='pending'",
  )
    .bind(actor, peer, Date.now())
    .run();
  const assertion = await signDocument(env, "openmew/assertion/v1", {
    v: 1,
    typ: "openmew.assertion.v1",
    iss: instanceDomain(env),
    sub: actor,
    aud: peer,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    profile_version: profile.profile_version,
  });
  await queueDelivery(
    env,
    peer,
    await newEvent(env, "user.link", { peer }, { actor }),
  );
  return assertion;
}
export async function validGuestSession(
  env: Env,
  claims: SessionTokenClaims,
): Promise<boolean> {
  if (
    claims.auth_source !== "federation" ||
    !isOriginTrusted(getInstanceConfig(env), domain(claims.actor))
  )
    return false;
  const row = await env.DB.prepare(
    "SELECT g.profile_status,g.sessions_revoked_at,s.issued_at FROM guest_identity g JOIN federation_sessions s ON s.actor=g.actor WHERE g.actor=? AND s.jti=? AND s.expires_at>?",
  )
    .bind(claims.actor, claims.jti, Date.now())
    .first<{
      profile_status: string;
      sessions_revoked_at: number | null;
      issued_at: number;
    }>();
  if (
    !row ||
    row.profile_status !== "active" ||
    (row.sessions_revoked_at && row.issued_at <= row.sessions_revoked_at)
  )
    return false;
  return !(await env.DB.prepare(
    "SELECT origin FROM federation_blocklist WHERE origin=?",
  )
    .bind(domain(claims.actor))
    .first());
}
export async function revokeGuest(env: Env, actor: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT stronghold_id FROM stronghold_member_index WHERE actor=?",
  )
    .bind(actor)
    .all<{ stronghold_id: string }>();
  for (const row of results)
    await env.STRONGHOLD_DO.getByName(row.stronghold_id).revokeServerRole(
      actor,
    );
}
export async function backfillRoom(
  env: Env,
  peer: string,
  room: string,
  actor: string,
): Promise<void> {
  const mapping = await env.DB.prepare(
    "SELECT high_water FROM federation_rooms WHERE origin=? AND room=? AND visibility='public'",
  )
    .bind(peer, room)
    .first<{ high_water: number }>();
  if (!mapping) throw new ProtocolError(404, "OMEW_ROOM_NOT_FOUND");
  const path = `/rooms/${room}/history?after=${mapping.high_water}&limit=200`;
  const response = await peerFetch(env, peer, path, {
    headers: await signedRequestHeaders(env, "GET", path, actor),
  });
  if (!response.ok) throw new ProtocolError(response.status, "OMEW_SEQ_GAP");
  const result = await boundedJson(response, 1_048_576);
  if (
    !object(result) ||
    !Array.isArray(result.events) ||
    result.events.length > 200
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (result.origin !== peer || result.room !== room)
    throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
  await verifyPeerDocument(env, "openmew/history/v1", result, peer);
  if (
    mapping.high_water === 0 &&
    Number.isSafeInteger(result.baseline) &&
    Number(result.baseline) > 0 &&
    Array.isArray(result.snapshot)
  ) {
    const snapshotStatements: D1PreparedStatement[] = [];
    for (const item of result.snapshot) {
      if (
        !object(item) ||
        !Number.isSafeInteger(item.seq) ||
        !object(item.body)
      )
        throw new ProtocolError(400, "OMEW_MALFORMED");
      const key = `federation/${peer}/${room}/snapshot-${item.seq}.json`;
      await env.MEDIA.put(
        key,
        JSON.stringify({ payload: { body: item.body } }),
      );
      snapshotStatements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO federation_items(origin,room,seq,parent_seq,root_seq,actor,kind,ts,r2_key) VALUES (?,?,?,?,?,?,?,?,?)",
        ).bind(
          peer,
          room,
          item.seq,
          item.parent_seq ?? null,
          item.root_seq ?? item.seq,
          item.actor,
          item.kind,
          item.ts,
          key,
        ),
      );
    }
    snapshotStatements.push(
      env.DB.prepare(
        "UPDATE federation_rooms SET high_water=? WHERE origin=? AND room=? AND high_water=0",
      ).bind(result.baseline, peer, room),
    );
    await env.DB.batch(snapshotStatements);
  }
  for (const value of result.events) {
    const event = await verifyEnvelope(env, value, true);
    if (event.origin !== peer || event.room !== room)
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
    await acceptEnvelope(env, event);
  }
}
export async function readReplica(
  env: Env,
  peer: string,
  room: string,
  before: number | null = null,
): Promise<JsonObject[]> {
  await assertPeer(env, peer);
  if (
    !canonicalRoom(room) ||
    !(await env.DB.prepare(
      "SELECT room FROM federation_rooms WHERE origin=? AND room=? AND visibility='public'",
    )
      .bind(peer, room)
      .first())
  )
    throw new ProtocolError(404, "OMEW_ROOM_NOT_FOUND");
  const { results } = await env.DB.prepare(
    "SELECT seq,parent_seq,root_seq,actor,kind,ts,r2_key,edit_key FROM federation_items WHERE origin=? AND room=? AND deleted=0 AND seq<? ORDER BY seq DESC LIMIT 100",
  )
    .bind(peer, room, before ?? Number.MAX_SAFE_INTEGER)
    .all<{
      seq: number;
      parent_seq: number | null;
      root_seq: number;
      actor: string;
      kind: string;
      ts: number;
      r2_key: string;
      edit_key: string | null;
    }>();
  return Promise.all(
    results.map(async (row) => {
      const key = row.edit_key ?? row.r2_key;
      const entry = await env.MEDIA.get(key);
      if (!entry) throw new ProtocolError(503, "OMEW_SEQ_GAP");
      const event = await entry.json<Envelope>();
      return {
        seq: row.seq,
        actor: row.actor,
        kind: row.kind,
        ts: row.ts,
        body: event.payload.body,
        ...(row.parent_seq ? { parent_seq: row.parent_seq } : {}),
        root_seq: row.root_seq,
      };
    }),
  );
}
export async function runFederationMaintenance(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM federation_seen WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM federation_assertions WHERE expires_at<?").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM federation_sessions WHERE expires_at<?").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM federation_rate WHERE window<?").bind(
      Math.floor(now / 60000) - 2,
    ),
  ]);
  const { results: delivery } = await env.DB.prepare(
    "SELECT peer,envelope FROM federation_delivery WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 50",
  )
    .bind(now)
    .all<{ peer: string; envelope: string }>();
  for (const row of delivery)
    await env.FEDERATION_OUT.send({
      peer: row.peer,
      envelope: JSON.parse(row.envelope),
    } satisfies Delivery);
  const { results: rooms } = await env.DB.prepare(
    "SELECT origin,room,subscriber,subscribed_until FROM federation_rooms WHERE visibility='public' ORDER BY last_backfill LIMIT 10",
  ).all<{
    origin: string;
    room: string;
    subscriber: string;
    subscribed_until: number;
  }>();
  for (const row of rooms) {
    if (!row.subscriber) continue;
    try {
      if (row.subscribed_until < Date.now() + 86400000) {
        const subscription = await signDocument(
          env,
          "openmew/subscription/v1",
          {
            v: 1,
            origin: instanceDomain(env),
            peer_instance: instanceDomain(env),
            room: row.room,
            ttl: 604800,
            aud: row.origin,
            ts: Date.now(),
          },
        );
        const response = await peerFetch(
          env,
          row.origin,
          "/federation/subscriptions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription),
          },
        );
        const result = await boundedJson(response);
        if (!response.ok || !object(result))
          throw new ProtocolError(response.status, "OMEW_ROOM_NOT_FOUND");
        await verifyPeerDocument(
          env,
          "openmew/subscription-response/v1",
          result,
          row.origin,
        );
        await env.DB.prepare(
          "UPDATE federation_rooms SET subscribed_until=? WHERE origin=? AND room=?",
        )
          .bind(result.expires_at, row.origin, row.room)
          .run();
      }
      await backfillRoom(env, row.origin, row.room, row.subscriber);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "federation.gap",
          origin: row.origin,
          room: row.room,
          error: String(error),
        }),
      );
    }
    await env.DB.prepare(
      "UPDATE federation_rooms SET last_backfill=? WHERE origin=? AND room=?",
    )
      .bind(Date.now(), row.origin, row.room)
      .run();
  }
  const { settleMigrations } = await import("./account-migration");
  await settleMigrations(env);
}
export async function consumeFederationQueue(
  batch: MessageBatch<Delivery>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { peer, envelope } = message.body;
    try {
      await assertPeer(env, peer);
      const pending = await env.DB.prepare(
        "SELECT expires_at,state FROM federation_delivery WHERE id=? AND peer=?",
      )
        .bind(envelope.id, peer)
        .first<{ expires_at: number; state: string }>();
      if (!pending || pending.state !== "pending") {
        message.ack();
        continue;
      }
      if (pending.expires_at < Date.now()) {
        await env.FEDERATION_DEAD.send(message.body);
        message.ack();
        continue;
      }
      if (envelope.room) {
        const [strongholdId, , resId] = envelope.room.split("/");
        const stronghold = env.STRONGHOLD_DO.getByName(strongholdId!);
        const [config, room] = await Promise.all([
          stronghold.getConfig(),
          stronghold.getRoom(resId!),
        ]);
        if (
          !config ||
          config.visibility !== "public" ||
          !room ||
          room.restricted ||
          room.archived
        ) {
          await env.DB.prepare(
            "DELETE FROM federation_delivery WHERE id=? AND peer=?",
          )
            .bind(envelope.id, peer)
            .run();
          message.ack();
          continue;
        }
      }
      const renewed =
        Math.abs(Date.now() - envelope.ts) > FRESH_MS
          ? await signDocument(env, "openmew/event/v1", {
              ...envelope,
              ts: Date.now(),
            })
          : envelope;
      const response = await peerFetch(env, peer, "/federation/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(renewed),
      });
      if (!response.ok)
        throw new ProtocolError(response.status, "OMEW_DELIVERY_FAILED");
      if (response.headers.has("OMEW-Revocation-Hint"))
        await discoverPeer(env, peer);
      await env.DB.prepare(
        "DELETE FROM federation_delivery WHERE id=? AND peer=?",
      )
        .bind(envelope.id, peer)
        .run();
      message.ack();
    } catch (error) {
      const next =
        Date.now() +
        Math.min(3600000, 1000 * 2 ** Math.min(message.attempts, 12));
      await env.DB.prepare(
        "UPDATE federation_delivery SET attempts=attempts+1,next_attempt=? WHERE id=? AND peer=?",
      )
        .bind(next, envelope.id, peer)
        .run();
      console.error(
        JSON.stringify({
          level: "warn",
          event: "federation.delivery_failed",
          origin: peer,
          id: envelope.id,
          attempt: message.attempts,
          error: String(error),
        }),
      );
      message.retry({ delaySeconds: Math.ceil((next - Date.now()) / 1000) });
    }
  }
}
export async function consumeDeadLetters(
  batch: MessageBatch<Delivery>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await env.DB.prepare(
      "UPDATE federation_delivery SET state='dead' WHERE id=? AND peer=?",
    )
      .bind(message.body.envelope.id, message.body.peer)
      .run();
    console.error(
      JSON.stringify({
        level: "error",
        event: "federation.dead_letter",
        origin: message.body.peer,
        id: message.body.envelope.id,
        attempts: message.attempts,
      }),
    );
    message.ack();
  }
}
export { ownKeys };
