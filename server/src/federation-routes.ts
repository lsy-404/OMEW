import { getInstanceConfig } from "./config";
import { instanceDomain, type SessionTokenClaims } from "./types";
import {
  boundedJson,
  canonicalActor,
  canonicalDomain,
  canonicalRoom,
  domain,
  object,
  ProtocolError,
  protocolResponse,
  type JsonObject,
} from "./federation-codec";
import {
  assertPeer,
  discoverPeer,
  ownKeys,
  peerFetch,
  pinPeerKeys,
  revokeOwnKey,
  rotateOwnKey,
  signDocument,
  verifyPeerDocument,
} from "./federation-keys";
import { localProfile, upsertGuestProfile } from "./federation-profiles";
import {
  backfillRoom,
  exchangeFederationSession,
  handleFederationInbox,
  issueFederationAssertion,
  newEvent,
  queueDelivery,
  readReplica,
  signedRequestHeaders,
  verifyRequest,
} from "./federation";
import {
  announceMigration,
  deliverMigrationProof,
  migrationRequest,
  prepareMigrationEdges,
} from "./account-migration";

export async function federationRoutes(
  request: Request,
  env: Env,
  session: SessionTokenClaims | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/federation/inbox" || path === "/inbox")
    return handleFederationInbox(request, env);
  if (path === "/federation/session" && method === "POST")
    return exchangeFederationSession(request, env);
  if (
    (path === "/migration/challenge" || path === "/migration/proof") &&
    method === "POST"
  )
    return migrationRequest(request, env, session?.actor ?? null);
  if (path === "/migration/status" && method === "GET") {
    const caller = await verifyRequest(env, request);
    const row = await env.DB.prepare(
      "SELECT mode,state,proof,effective_at FROM account_migrations WHERE old_actor=? AND new_actor=?",
    )
      .bind(url.searchParams.get("old"), caller.actor)
      .first<{
        mode: string;
        state: string;
        proof: string;
        effective_at: number;
      }>();
    if (!row || JSON.parse(row.proof).nonce !== url.searchParams.get("nonce"))
      throw new ProtocolError(404, "OMEW_NOT_FOUND");
    return protocolResponse({
      mode: row.mode,
      state: row.state,
      effective_at: row.effective_at,
    });
  }
  if (path === "/.well-known/openmew/keys" && method === "GET")
    return protocolResponse(await ownKeys(env));
  if (path === "/.well-known/openmew/instance" && method === "GET") {
    const policy = getInstanceConfig(env);
    const { results } = await env.DB.prepare(
      "SELECT stronghold_id AS id,name,description,member_count,slug FROM stronghold_directory_index WHERE visibility='public' ORDER BY stronghold_id LIMIT 200",
    ).all<JsonObject>();
    return protocolResponse(
      await signDocument(env, "openmew/instance-descriptor/v1", {
        v: 1,
        instance: instanceDomain(env),
        name: env.INSTANCE_NAME ?? "OMEW",
        software: "openmew",
        version: "1.0.0",
        capabilities: [
          "federation.session",
          "federation.history",
          "media.attachments",
        ],
        public_strongholds: results.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)),
        ),
        known_peers: policy.federation_peers,
      }),
    );
  }
  if (path.startsWith("/.well-known/openmew/users/") && method === "GET") {
    const localpart = decodeURIComponent(
      path.slice("/.well-known/openmew/users/".length),
    );
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(localpart))
      throw new ProtocolError(404, "OMEW_NOT_FOUND");
    return protocolResponse(
      await localProfile(env, `@${localpart}:${instanceDomain(env)}`),
    );
  }
  if (path === "/federation/subscriptions" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      !canonicalDomain(body.origin) ||
      body.peer_instance !== body.origin ||
      !canonicalRoom(body.room) ||
      body.aud !== instanceDomain(env) ||
      !Number.isSafeInteger(body.ttl) ||
      Number(body.ttl) < 1 ||
      Number(body.ttl) > 604800 ||
      !Number.isSafeInteger(body.ts) ||
      Math.abs(Date.now() - Number(body.ts)) > 300000
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await verifyPeerDocument(env, "openmew/subscription/v1", body, body.origin);
    const [id, kind, resId] = body.room.split("/");
    const stub = env.STRONGHOLD_DO.getByName(id!);
    const [config, room] = await Promise.all([
      stub.getConfig(),
      stub.getRoom(resId!),
    ]);
    if (
      !config ||
      config.visibility !== "public" ||
      !room ||
      room.restricted ||
      room.archived ||
      (room.type === "section" ? "sec" : "ch") !== kind
    )
      throw new ProtocolError(403, "OMEW_ROOM_NOT_FOUND");
    const expiredAt = Date.now() + Number(body.ttl) * 1000;
    const reserved = await env.DB.prepare(
      "INSERT INTO federation_host_subscriptions(peer,room,expires_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM federation_host_subscriptions WHERE peer=? AND expires_at>?)<100 OR EXISTS(SELECT 1 FROM federation_host_subscriptions WHERE peer=? AND room=? AND expires_at>?) ON CONFLICT(peer,room) DO UPDATE SET expires_at=excluded.expires_at RETURNING room",
    )
      .bind(
        body.origin,
        body.room,
        expiredAt,
        body.origin,
        Date.now(),
        body.origin,
        body.room,
        Date.now(),
      )
      .first();
    if (!reserved) throw new ProtocolError(429, "OMEW_SUBSCRIPTION_QUOTA");
    const latest = await env.ROOM_DO.getByName(body.room).registerSubscription(
      body.origin,
      expiredAt,
    );
    return protocolResponse(
      await signDocument(env, "openmew/subscription-response/v1", {
        origin: instanceDomain(env),
        room: body.room,
        expires_at: expiredAt,
        latest_seq: latest,
      }),
    );
  }
  if (path.startsWith("/federation/subscriptions/") && method === "DELETE") {
    const caller = await verifyRequest(env, request);
    const room = path.slice("/federation/subscriptions/".length);
    if (!canonicalRoom(room)) throw new ProtocolError(400, "OMEW_MALFORMED");
    await env.ROOM_DO.getByName(room).removeSubscription(caller.origin);
    await env.DB.prepare(
      "DELETE FROM federation_host_subscriptions WHERE peer=? AND room=?",
    )
      .bind(caller.origin, room)
      .run();
    return protocolResponse({ ok: true });
  }
  if (
    path.startsWith("/rooms/") &&
    path.endsWith("/history") &&
    method === "GET"
  ) {
    const caller = await verifyRequest(env, request);
    const roomRef = path.slice(7, -8);
    if (!canonicalRoom(roomRef)) throw new ProtocolError(400, "OMEW_MALFORMED");
    const [id, kind, resId] = roomRef.split("/");
    const stub = env.STRONGHOLD_DO.getByName(id!);
    const [config, room, member] = await Promise.all([
      stub.getConfig(),
      stub.getRoom(resId!),
      stub.getMember(caller.actor),
    ]);
    if (
      !config ||
      !room ||
      room.restricted ||
      (room.type === "section" ? "sec" : "ch") !== kind ||
      config.visibility !== "public"
    )
      throw new ProtocolError(403, "OMEW_ROOM_NOT_FOUND");
    if (member?.banned_at) throw new ProtocolError(403, "OMEW_BANNED");
    const limit = Math.max(
      1,
      Math.min(Number(url.searchParams.get("limit") ?? 50), 200),
    );
    const before = url.searchParams.has("before")
      ? Number(url.searchParams.get("before"))
      : null;
    const after = Number(url.searchParams.get("after") ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      (before !== null && !Number.isSafeInteger(before)) ||
      !Number.isSafeInteger(after)
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    const result = await env.ROOM_DO.getByName(roomRef).getFederationHistory(
      roomRef,
      after,
      before,
      limit,
      url.searchParams.has("snapshot_before")
        ? Number(url.searchParams.get("snapshot_before"))
        : null,
    );
    const [latestConfig, latestRoom] = await Promise.all([
      stub.getConfig(),
      stub.getRoom(resId!),
    ]);
    if (
      latestConfig?.visibility !== "public" ||
      !latestRoom ||
      latestRoom.restricted
    )
      throw new ProtocolError(403, "OMEW_ROOM_NOT_FOUND");
    return protocolResponse(
      await signDocument(env, "openmew/history/v1", result),
    );
  }
  if (
    !path.startsWith("/api/federation/") &&
    !path.startsWith("/api/admin/federation/") &&
    !path.startsWith("/api/me/migration/") &&
    path !== "/api/me/links"
  )
    return null;
  if (!session) throw new ProtocolError(401, "OMEW_SESSION_INVALID");
  if (
    path.startsWith("/api/admin/federation/") &&
    session.server_role !== "owner"
  )
    throw new ProtocolError(403, "OMEW_FORBIDDEN");
  if (path === "/api/federation/peers" && method === "GET") {
    const rooms = await env.DB.prepare(
      "SELECT origin,room,high_water,subscribed_until FROM federation_rooms WHERE visibility='public' ORDER BY origin,room",
    ).all();
    return protocolResponse({
      peers: getInstanceConfig(env).federation_peers,
      rooms: rooms.results,
    });
  }
  if (path === "/api/me/links" && method === "GET")
    return protocolResponse({
      edges: (
        await env.DB.prepare(
          "SELECT peer_instance,state,created_at,confirmed_at FROM user_link WHERE actor=?",
        )
          .bind(session.actor)
          .all()
      ).results,
    });
  if (path === "/api/federation/join-request" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      typeof body.peer !== "string" ||
      typeof body.stronghold !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.stronghold)
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (domain(session.actor) !== instanceDomain(env))
      throw new ProtocolError(403, "OMEW_FORBIDDEN");
    await queueDelivery(
      env,
      body.peer,
      await newEvent(
        env,
        "member.join_request",
        { stronghold: body.stronghold, subject: session.actor },
        { actor: session.actor },
      ),
    );
    return protocolResponse({ state: "pending" }, 202);
  }
  if (path === "/api/federation/assertion" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.peer !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    return protocolResponse(
      await issueFederationAssertion(env, session.actor, body.peer),
    );
  }
  if (path === "/api/federation/descriptor" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.peer !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    const response = await peerFetch(
      env,
      body.peer,
      "/.well-known/openmew/instance",
    );
    const descriptor = await boundedJson(response);
    if (!object(descriptor) || descriptor.instance !== body.peer)
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await verifyPeerDocument(
      env,
      "openmew/instance-descriptor/v1",
      descriptor,
      body.peer,
    );
    return protocolResponse(descriptor);
  }
  if (path === "/api/federation/subscribe" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      typeof body.peer !== "string" ||
      !canonicalRoom(body.room)
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await assertPeer(env, body.peer);
    const subscription = await signDocument(env, "openmew/subscription/v1", {
      v: 1,
      origin: instanceDomain(env),
      peer_instance: instanceDomain(env),
      room: body.room,
      ttl: 604800,
      aud: body.peer,
      ts: Date.now(),
    });
    const response = await peerFetch(
      env,
      body.peer,
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
      body.peer,
    );
    if (result.room !== body.room || result.origin !== body.peer)
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
    await env.DB.prepare(
      "INSERT INTO federation_rooms(origin,room,subscribed_until,subscriber) VALUES (?,?,?,?) ON CONFLICT(origin,room) DO UPDATE SET subscribed_until=excluded.subscribed_until,subscriber=excluded.subscriber,visibility='public'",
    )
      .bind(body.peer, body.room, result.expires_at, session.actor)
      .run();
    await backfillRoom(env, body.peer, body.room, session.actor);
    return protocolResponse({ ok: true });
  }
  if (path === "/api/federation/history" && method === "GET")
    return protocolResponse({
      items: await readReplica(
        env,
        url.searchParams.get("peer") ?? "",
        url.searchParams.get("room") ?? "",
        url.searchParams.has("before")
          ? Number(url.searchParams.get("before"))
          : null,
      ),
    });
  if (path === "/api/admin/federation/keys/rotate" && method === "POST")
    return protocolResponse(await rotateOwnKey(env));
  if (path === "/api/admin/federation/keys/revoke" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.key_id !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await revokeOwnKey(env, body.key_id);
    return protocolResponse({ ok: true });
  }
  if (path === "/api/admin/federation/pin" && method === "POST") {
    const body = await boundedJson(request, 65536, true);
    if (!object(body) || typeof body.peer !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await pinPeerKeys(env, body.peer, body.document);
    return protocolResponse({ ok: true });
  }
  if (path === "/api/admin/federation/discover" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.peer !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await discoverPeer(env, body.peer);
    return protocolResponse({ ok: true });
  }
  if (path === "/api/admin/federation/block" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || !canonicalDomain(body.peer))
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (body.blocked === false)
      await env.DB.prepare("DELETE FROM federation_blocklist WHERE origin=?")
        .bind(body.peer)
        .run();
    else {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO federation_blocklist(origin,blocked_at) VALUES (?,?)",
      )
        .bind(body.peer, Date.now())
        .run();
      const { results: subscriptions } = await env.DB.prepare(
        "SELECT room FROM federation_host_subscriptions WHERE peer=?",
      )
        .bind(body.peer)
        .all<{ room: string }>();
      for (const subscription of subscriptions)
        await env.ROOM_DO.getByName(subscription.room).removeSubscription(
          body.peer,
        );
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM federation_host_subscriptions WHERE peer=?",
        ).bind(body.peer),
        env.DB.prepare(
          "UPDATE federation_delivery SET state='dead' WHERE peer=? AND state='pending'",
        ).bind(body.peer),
      ]);
      const { results } = await env.DB.prepare(
        "SELECT actor FROM guest_identity WHERE registered_origin=?",
      )
        .bind(body.peer)
        .all<{ actor: string }>();
      const { revokeGuest } = await import("./federation");
      for (const row of results) {
        await env.DB.prepare("DELETE FROM federation_sessions WHERE actor=?")
          .bind(row.actor)
          .run();
        await revokeGuest(env, row.actor);
      }
    }
    return protocolResponse({ ok: true });
  }
  if (path === "/api/me/migration/prepare" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || !canonicalActor(body.old))
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (object(body.profile)) {
      if (body.profile.actor !== body.old)
        throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
      await verifyPeerDocument(
        env,
        "openmew/user-profile/v1",
        body.profile,
        domain(body.old),
      );
      await upsertGuestProfile(env, body.profile, domain(body.old));
    } else {
      const response = await peerFetch(
        env,
        domain(body.old),
        `/.well-known/openmew/users/${body.old.slice(1, body.old.indexOf(":"))}`,
      );
      const profile = await boundedJson(response);
      if (!object(profile) || profile.actor !== body.old)
        throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
      await verifyPeerDocument(
        env,
        "openmew/user-profile/v1",
        profile,
        domain(body.old),
      );
      await upsertGuestProfile(env, profile, domain(body.old));
    }
    const { issueMigrationChallenge } = await import("./account-migration");
    return protocolResponse(
      await issueMigrationChallenge(env, body.old, session.actor),
    );
  }
  if (path === "/api/me/migration/release" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      !canonicalActor(body.new) ||
      domain(session.actor) !== instanceDomain(env)
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await env.DB.prepare(
      "INSERT INTO federation_local_profile(actor,moved_to,version) VALUES (?,?,1) ON CONFLICT(actor) DO UPDATE SET moved_to=excluded.moved_to,version=version+1",
    )
      .bind(session.actor, body.new)
      .run();
    const profile = await localProfile(env, session.actor);
    const event = await newEvent(
      env,
      "user.update",
      { profile_version: profile.profile_version, moved_to: body.new },
      { actor: session.actor },
    );
    const { results } = await env.DB.prepare(
      "SELECT peer_instance FROM user_link WHERE actor=?",
    )
      .bind(session.actor)
      .all<{ peer_instance: string }>();
    for (const link of results)
      if (getInstanceConfig(env).federation_peers.includes(link.peer_instance))
        await queueDelivery(env, link.peer_instance, event);
    return protocolResponse(event);
  }
  if (path === "/api/me/migration/custody" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      typeof body.old !== "string" ||
      typeof body.ownership_ciphertext !== "string" ||
      body.ownership_ciphertext.length > 8192
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (
      !(await env.DB.prepare(
        "SELECT old_actor FROM account_migrations WHERE old_actor=? AND new_actor=?",
      )
        .bind(body.old, session.actor)
        .first())
    )
      throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
    const envelope = JSON.parse(body.ownership_ciphertext);
    if (
      !object(envelope) ||
      envelope.v !== 1 ||
      envelope.kdf !== "argon2id" ||
      envelope.cipher !== "AES-256-GCM"
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    await env.DB.prepare(
      "UPDATE users SET ownership_ciphertext=? WHERE localpart=?",
    )
      .bind(
        body.ownership_ciphertext,
        session.actor.slice(1, session.actor.indexOf(":")),
      )
      .run();
    return protocolResponse({ ok: true });
  }
  if (path === "/api/me/migration/edges" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || !canonicalActor(body.old))
      throw new ProtocolError(400, "OMEW_MALFORMED");
    if (
      !(await env.DB.prepare(
        "SELECT old_actor FROM account_migrations WHERE old_actor=? AND new_actor=?",
      )
        .bind(body.old, session.actor)
        .first())
    )
      throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
    return protocolResponse({
      edges: await prepareMigrationEdges(
        env,
        body.old,
        session.actor,
        body.peers,
      ),
    });
  }
  if (path === "/api/me/migration/edge-proof" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.peer !== "string" || !object(body.proof))
      throw new ProtocolError(400, "OMEW_MALFORMED");
    return protocolResponse(
      await deliverMigrationProof(env, session.actor, body.peer, body.proof),
    );
  }
  if (path === "/api/me/migration/announce" && method === "POST") {
    const body = await boundedJson(request);
    if (
      !object(body) ||
      !object(body.proof) ||
      !Array.isArray(body.peers) ||
      !body.peers.every((p) => typeof p === "string")
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    return protocolResponse(
      await announceMigration(env, session.actor, body.proof, body.peers),
    );
  }
  if (path === "/api/me/migration/object" && method === "POST") {
    const body = await boundedJson(request);
    if (!object(body) || typeof body.target_id !== "string")
      throw new ProtocolError(400, "OMEW_MALFORMED");
    const proof = await newEvent(
      env,
      "user.move_objection",
      { old: session.actor, target_id: body.target_id },
      { actor: session.actor },
    );
    const { results } = await env.DB.prepare(
      "SELECT peer_instance FROM user_link WHERE actor=?",
    )
      .bind(session.actor)
      .all<{ peer_instance: string }>();
    for (const row of results)
      await queueDelivery(env, row.peer_instance, proof);
    return protocolResponse(proof);
  }
  if (path === "/api/me/migration/status" && method === "GET") {
    const migrations = await env.DB.prepare(
      "SELECT old_actor,new_actor,mode,state,effective_at,proof FROM account_migrations WHERE new_actor=?",
    )
      .bind(session.actor)
      .all();
    const edges = await env.DB.prepare(
      "SELECT old_actor,peer,state,error FROM migration_edges WHERE new_actor=?",
    )
      .bind(session.actor)
      .all();
    return protocolResponse({
      migrations: migrations.results,
      edges: edges.results,
    });
  }
  throw new ProtocolError(404, "OMEW_NOT_FOUND");
}
