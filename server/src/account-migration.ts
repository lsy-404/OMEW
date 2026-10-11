import { base64UrlEncode } from "./auth";
import { instanceDomain } from "./types";
import {
  boundedJson,
  canonicalActor,
  domain,
  Envelope,
  FRESH_MS,
  object,
  ProtocolError,
  protocolResponse,
  verifyObject,
  type JsonObject,
} from "./federation-codec";
import { assertPeer, peerFetch, verifyPeerDocument } from "./federation-keys";
import { pinOwnership, type OwnershipKey } from "./federation-profiles";
import {
  newEvent,
  queueDelivery,
  rateLimit,
  revokeGuest,
  signedRequestHeaders,
  verifyRequest,
} from "./federation";

const NOTICE_MS = 604_800_000;
interface MigrationRow {
  old_actor: string;
  new_actor: string;
  mode: string;
  state: string;
  proof: string;
  announcement_id: string | null;
  announcement: string | null;
  error: string | null;
  effective_at: number;
}
export async function migrationCaller(
  request: Request,
  env: Env,
  sessionActor: string | null,
): Promise<string> {
  return request.headers.get("Authorization")?.startsWith("OpenMew ")
    ? (await verifyRequest(env, request)).actor
    : (sessionActor ??
        (() => {
          throw new ProtocolError(401, "OMEW_SESSION_INVALID");
        })());
}
export async function issueMigrationChallenge(
  env: Env,
  oldActor: string,
  newActor: string,
): Promise<JsonObject> {
  if (
    !canonicalActor(oldActor) ||
    !canonicalActor(newActor) ||
    oldActor === newActor ||
    domain(oldActor) === domain(newActor)
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (
    !(await env.DB.prepare(
      "SELECT key_id FROM ownership_pins WHERE actor=? LIMIT 1",
    )
      .bind(oldActor)
      .first())
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const exp = Date.now() + 600000;
  await env.DB.prepare(
    "INSERT INTO migration_challenges(nonce,old_actor,new_actor,expires_at) VALUES (?,?,?,?)",
  )
    .bind(nonce, oldActor, newActor, exp)
    .run();
  return { nonce, challenge_origin: instanceDomain(env), exp };
}
async function verifyRelease(env: Env, proof: JsonObject): Promise<boolean> {
  if (proof.home_release === undefined) return false;
  const release = proof.home_release;
  if (
    !object(release) ||
    release.type !== "user.update" ||
    release.origin !== domain(String(proof.old)) ||
    release.actor !== proof.old ||
    !object(release.payload) ||
    release.payload.moved_to !== proof.new ||
    !Number.isSafeInteger(release.ts) ||
    Date.now() - Number(release.ts) > 30 * 86400000 ||
    Number(release.ts) > Date.now() + FRESH_MS
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  await verifyPeerDocument(
    env,
    "openmew/event/v1",
    release,
    String(release.origin),
    Number(release.ts),
  );
  return true;
}
async function verifyClaim(env: Env, proof: JsonObject): Promise<OwnershipKey> {
  const { results: pins } = await env.DB.prepare(
    "SELECT key_id,public_key,created_at,prev_key_id,continuity_sig FROM ownership_pins WHERE actor=? ORDER BY created_at",
  )
    .bind(proof.old)
    .all<OwnershipKey>();
  if (!pins.length)
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const history = Array.isArray(proof.key_history)
    ? proof.key_history.filter(object)
    : [];
  const current =
    history.find((entry) => entry.key_id === proof.ownership_key_id) ??
    pins.find((entry) => entry.key_id === proof.ownership_key_id);
  if (!current) throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const tail = await pinOwnership(env, String(proof.old), current, history);
  if (
    !(await verifyObject(
      "openmew/migration-claim/v1",
      {
        old: proof.old,
        new: proof.new,
        nonce: proof.nonce,
        challenge_origin: proof.challenge_origin,
        signed_at: proof.signed_at,
        sig: proof.sig,
      },
      tail.public_key,
    ))
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  return tail;
}
export async function acceptMigrationProof(
  env: Env,
  proof: unknown,
  caller: string,
): Promise<JsonObject> {
  if (
    !object(proof) ||
    !canonicalActor(proof.old) ||
    !canonicalActor(proof.new) ||
    caller !== proof.new ||
    proof.challenge_origin !== instanceDomain(env) ||
    !Number.isSafeInteger(proof.signed_at) ||
    Math.abs(Date.now() - Number(proof.signed_at)) > 600000
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  if (domain(proof.new) !== instanceDomain(env))
    await assertPeer(env, domain(proof.new));
  const challenge = await env.DB.prepare(
    "SELECT old_actor,new_actor,expires_at,used_at FROM migration_challenges WHERE nonce=?",
  )
    .bind(proof.nonce)
    .first<{
      old_actor: string;
      new_actor: string;
      expires_at: number;
      used_at: number | null;
    }>();
  if (!challenge || challenge.used_at || challenge.expires_at < Date.now())
    throw new ProtocolError(409, "OMEW_CHALLENGE_STALE");
  if (challenge.old_actor !== proof.old || challenge.new_actor !== proof.new)
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const key = await verifyClaim(env, proof);
  if (domain(proof.new) === instanceDomain(env)) {
    const pinned = await env.DB.prepare(
      "SELECT key_id FROM ownership_pins WHERE actor=? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(proof.new)
      .first<{ key_id: string }>();
    if (pinned && pinned.key_id !== key.key_id)
      throw new ProtocolError(409, "OMEW_MIGRATION_TARGET_IN_USE");
  }
  const released = await verifyRelease(env, proof);
  const existing = await env.DB.prepare(
    "SELECT * FROM account_migrations WHERE old_actor=?",
  )
    .bind(proof.old)
    .first<MigrationRow>();
  if (existing?.state === "frozen" && !released)
    throw new ProtocolError(409, "OMEW_MIGRATION_FROZEN");
  if (existing?.state === "pending" && !released)
    throw new ProtocolError(409, "OMEW_MIGRATION_PENDING");
  if (existing?.state === "completed")
    throw new ProtocolError(409, "OMEW_ACTOR_DEACTIVATED");
  const announcement = await env.DB.prepare(
    "SELECT id,effective_at FROM migration_announcements WHERE old_actor=? AND new_actor=? AND mode=?",
  )
    .bind(proof.old, proof.new, released ? "dual_sign" : "disaster")
    .first<{ id: string; effective_at: number }>();
  const now = Date.now();
  const effectiveAt = released
    ? now
    : (announcement?.effective_at ?? now + NOTICE_MS);
  const accepted = await env.DB.batch([
    env.DB.prepare(
      "UPDATE migration_challenges SET used_at=? WHERE nonce=? AND used_at IS NULL AND expires_at>=?",
    ).bind(now, proof.nonce, now),
    env.DB.prepare(
      "INSERT INTO account_migrations(old_actor,new_actor,mode,state,proof,announcement_id,accepted_at,effective_at) SELECT ?,?,?,'pending',?,?,?,? WHERE changes()=1 ON CONFLICT(old_actor) DO UPDATE SET new_actor=excluded.new_actor,mode=excluded.mode,state='pending',proof=excluded.proof,announcement_id=excluded.announcement_id,announcement=NULL,error=NULL,accepted_at=excluded.accepted_at,effective_at=excluded.effective_at",
    ).bind(
      proof.old,
      proof.new,
      released ? "dual_sign" : "disaster",
      JSON.stringify(proof),
      announcement?.id ?? null,
      now,
      effectiveAt,
    ),
  ]);
  if (accepted[0]!.meta.changes !== 1)
    throw new ProtocolError(409, "OMEW_CHALLENGE_STALE");
  if (domain(proof.new) === instanceDomain(env)) {
    await env.DB.prepare(
      "UPDATE users SET ownership_pubkey=? WHERE localpart=?",
    )
      .bind(key.public_key, proof.new.slice(1, proof.new.indexOf(":")))
      .run();
    const entry = {
      key_id: key.key_id,
      public_key: key.public_key,
      created_at: key.created_at,
    };
    await pinOwnership(env, proof.new, entry);
    await env.DB.prepare(
      "INSERT INTO federation_local_profile(actor,ownership_entry) VALUES (?,?) ON CONFLICT(actor) DO UPDATE SET ownership_entry=excluded.ownership_entry",
    )
      .bind(proof.new, JSON.stringify(entry))
      .run();
  }
  if (released) await settleMigrations(env);
  const result = await env.DB.prepare(
    "SELECT state,error FROM account_migrations WHERE old_actor=?",
  )
    .bind(proof.old)
    .first<{ state: string; error: string | null }>();
  return {
    mode: released ? "dual_sign" : "disaster",
    state: result!.state,
    ...(result!.error ? { error: result!.error } : {}),
    effective_at: effectiveAt,
  };
}
export async function acceptMigrationAnnouncement(
  env: Env,
  event: Envelope,
): Promise<void> {
  const p = event.payload;
  if (!canonicalActor(p.old)) throw new ProtocolError(400, "OMEW_MALFORMED");
  if (event.type === "user.move_objection") {
    if (domain(p.old) !== event.origin || typeof p.target_id !== "string")
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
    await env.DB.prepare(
      "UPDATE account_migrations SET state='frozen' WHERE old_actor=? AND mode='disaster' AND state='pending' AND announcement_id=? AND effective_at>?",
    )
      .bind(p.old, p.target_id, Date.now())
      .run();
    return;
  }
  if (
    !canonicalActor(p.new) ||
    p.new !== event.actor ||
    !["dual_sign", "disaster"].includes(String(p.mode)) ||
    !object(p.proof)
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  await verifyClaim(env, { ...p.proof, old: p.old, new: p.new });
  const released = await verifyRelease(env, {
    ...p.proof,
    old: p.old,
    new: p.new,
    ...(p.home_release ? { home_release: p.home_release } : {}),
  });
  if (p.mode !== (released ? "dual_sign" : "disaster"))
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const effectiveAt = released ? event.ts : event.ts + NOTICE_MS;
  await env.DB.prepare(
    "INSERT INTO migration_announcements(old_actor,new_actor,id,mode,ts,effective_at) VALUES (?,?,?,?,?,?) ON CONFLICT(old_actor) DO NOTHING",
  )
    .bind(p.old, p.new, event.id, p.mode, event.ts, effectiveAt)
    .run();
  await env.DB.prepare(
    "UPDATE account_migrations SET announcement_id=?,effective_at=? WHERE old_actor=? AND new_actor=? AND state='pending' AND mode=? AND announcement_id IS NULL",
  )
    .bind(event.id, effectiveAt, p.old, p.new, p.mode)
    .run();
}
export async function settleMigrations(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM account_migrations WHERE state='pending' AND effective_at<=? LIMIT 20",
  )
    .bind(Date.now())
    .all<MigrationRow>();
  for (const row of results) {
    try {
      const { results: memberships } = await env.DB.prepare(
        "SELECT stronghold_id FROM stronghold_member_index WHERE actor=?",
      )
        .bind(row.old_actor)
        .all<{ stronghold_id: string }>();
      for (const membership of memberships)
        await env.STRONGHOLD_DO.getByName(
          membership.stronghold_id,
        ).migrateMember(row.old_actor, row.new_actor);
      await revokeGuest(env, row.old_actor);
      const guest = await env.DB.prepare(
        "SELECT * FROM guest_identity WHERE actor=?",
      )
        .bind(row.old_actor)
        .first<Record<string, unknown>>();
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          "INSERT OR IGNORE INTO actor_aliases(old_actor,new_actor,moved_at) VALUES (?,?,?)",
        ).bind(row.old_actor, row.new_actor, Date.now()),
        env.DB.prepare(
          "UPDATE guest_identity SET profile_status='deactivated',sessions_revoked_at=? WHERE actor=?",
        ).bind(Date.now(), row.old_actor),
        env.DB.prepare("DELETE FROM federation_sessions WHERE actor=?").bind(
          row.old_actor,
        ),
      ];
      if (guest && domain(row.new_actor) !== instanceDomain(env)) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO guest_identity(actor,registered_origin,profile_version,display_name,avatar,profile_status,ownership_key_json,key_history_json,first_seen_at,last_assertion_at) VALUES (?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(actor) DO UPDATE SET registered_origin=excluded.registered_origin",
          ).bind(
            row.new_actor,
            domain(row.new_actor),
            -1,
            guest.display_name,
            guest.avatar,
            guest.ownership_key_json,
            guest.key_history_json,
            guest.first_seen_at,
            Date.now(),
          ),
        );
      }
      if (domain(row.new_actor) === instanceDomain(env)) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO federation_local_profile(actor,aliases) VALUES (?,?) ON CONFLICT(actor) DO UPDATE SET aliases=excluded.aliases",
          ).bind(row.new_actor, JSON.stringify([row.old_actor])),
        );
      }
      statements.push(
        env.DB.prepare(
          "UPDATE account_migrations SET state='completed',error=NULL WHERE old_actor=? AND state='pending'",
        ).bind(row.old_actor),
      );
      await env.DB.batch(statements);
    } catch (error) {
      await env.DB.prepare(
        "UPDATE account_migrations SET error=? WHERE old_actor=? AND state='pending'",
      )
        .bind(String(error), row.old_actor)
        .run();
      console.error(
        JSON.stringify({
          level: "error",
          event: "migration.conflict",
          actor: row.old_actor,
          error: String(error),
        }),
      );
    }
  }
  await env.DB.prepare("DELETE FROM migration_challenges WHERE expires_at<?")
    .bind(Date.now() - 86400000)
    .run();
}
export async function prepareMigrationEdges(
  env: Env,
  oldActor: string,
  newActor: string,
  peers: unknown,
): Promise<JsonObject[]> {
  if (
    !Array.isArray(peers) ||
    peers.length > 100 ||
    !peers.every((p) => typeof p === "string")
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  const result: JsonObject[] = [];
  for (const peer of [...new Set(peers as string[])]) {
    if (peer === instanceDomain(env)) continue;
    await assertPeer(env, peer);
    await env.DB.prepare(
      "INSERT INTO migration_edges(old_actor,new_actor,peer,state,updated_at) VALUES (?,?,?,'pending',?) ON CONFLICT(old_actor,peer) DO NOTHING",
    )
      .bind(oldActor, newActor, peer, Date.now())
      .run();
    const state = await env.DB.prepare(
      "SELECT state,challenge,proof FROM migration_edges WHERE old_actor=? AND peer=?",
    )
      .bind(oldActor, peer)
      .first<{
        state: string;
        challenge: string | null;
        proof: string | null;
      }>();
    if (state!.state === "resolved") {
      result.push({ peer, state: "resolved" });
      continue;
    }
    try {
      const path = "/migration/challenge";
      const response = await peerFetch(env, peer, path, {
        method: "POST",
        headers: await signedRequestHeaders(env, "POST", path, newActor),
        body: JSON.stringify({ old: oldActor, new: newActor }),
      });
      const challenge = await boundedJson(response);
      if (
        !response.ok ||
        !object(challenge) ||
        challenge.challenge_origin !== peer
      )
        throw new ProtocolError(
          response.status,
          "OMEW_OWNERSHIP_PROOF_INVALID",
        );
      await env.DB.prepare(
        "UPDATE migration_edges SET state='awaiting_proof',challenge=?,proof=NULL,error=NULL,updated_at=? WHERE old_actor=? AND peer=?",
      )
        .bind(JSON.stringify(challenge), Date.now(), oldActor, peer)
        .run();
      result.push({ peer, state: "awaiting_proof", challenge });
    } catch (error) {
      await env.DB.prepare(
        "UPDATE migration_edges SET error=?,updated_at=? WHERE old_actor=? AND peer=?",
      )
        .bind(String(error), Date.now(), oldActor, peer)
        .run();
      result.push({ peer, state: "pending", error: String(error) });
    }
  }
  return result;
}
export async function deliverMigrationProof(
  env: Env,
  newActor: string,
  peer: string,
  proof: JsonObject,
): Promise<JsonObject> {
  if (
    proof.new !== newActor ||
    typeof proof.old !== "string" ||
    proof.challenge_origin !== peer
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const state = await env.DB.prepare(
    "SELECT old_actor FROM migration_edges WHERE old_actor=? AND new_actor=? AND peer=?",
  )
    .bind(proof.old, newActor, peer)
    .first();
  if (!state) throw new ProtocolError(404, "OMEW_NOT_FOUND");
  await env.DB.prepare(
    "UPDATE migration_edges SET proof=?,state='delivering',error=NULL,updated_at=? WHERE old_actor=? AND peer=?",
  )
    .bind(JSON.stringify(proof), Date.now(), proof.old, peer)
    .run();
  return attemptMigrationDelivery(env, newActor, peer, proof);
}

async function attemptMigrationDelivery(
  env: Env,
  newActor: string,
  peer: string,
  proof: JsonObject,
): Promise<JsonObject> {
  try {
    const path = "/migration/proof";
    const response = await peerFetch(env, peer, path, {
      method: "POST",
      headers: await signedRequestHeaders(env, "POST", path, newActor),
      body: JSON.stringify(proof),
    });
    let result = await boundedJson(response);
    let accepted = response.ok;
    if (!accepted && response.status === 409) {
      const statusPath = `/migration/status?old=${encodeURIComponent(String(proof.old))}&nonce=${encodeURIComponent(String(proof.nonce))}`;
      const status = await peerFetch(env, peer, statusPath, {
        headers: await signedRequestHeaders(env, "GET", statusPath, newActor),
      });
      if (status.ok) {
        result = await boundedJson(status);
        accepted = true;
      }
    }
    if (!accepted) {
      const code =
        object(result) && object(result.error)
          ? String(result.error.code)
          : "OMEW_DELIVERY_FAILED";
      throw new ProtocolError(response.status, code);
    }
    await env.DB.prepare(
      "UPDATE migration_edges SET state='resolved',error=NULL,updated_at=? WHERE old_actor=? AND peer=?",
    )
      .bind(Date.now(), proof.old, peer)
      .run();
    return { peer, state: "resolved", result };
  } catch (error) {
    const needsProof =
      error instanceof ProtocolError &&
      ["OMEW_CHALLENGE_STALE", "OMEW_OWNERSHIP_PROOF_INVALID"].includes(
        error.code,
      );
    await env.DB.prepare(
      "UPDATE migration_edges SET state=?,error=?,updated_at=? WHERE old_actor=? AND peer=?",
    )
      .bind(
        needsProof ? "awaiting_proof" : "delivering",
        String(error),
        Date.now(),
        proof.old,
        peer,
      )
      .run();
    return {
      peer,
      state: needsProof ? "awaiting_proof" : "delivering",
      error: String(error),
    };
  }
}

export async function retryMigrationEdges(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT new_actor,peer,proof FROM migration_edges WHERE state='delivering' AND proof IS NOT NULL AND updated_at<? ORDER BY updated_at LIMIT 10",
  )
    .bind(Date.now() - 60000)
    .all<{ new_actor: string; peer: string; proof: string }>();
  for (const row of results)
    await attemptMigrationDelivery(
      env,
      row.new_actor,
      row.peer,
      JSON.parse(row.proof),
    );
}
export async function migrationRequest(
  request: Request,
  env: Env,
  actor: string | null,
): Promise<Response> {
  await rateLimit(
    env,
    `migration:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    30,
  );
  const caller = await migrationCaller(request, env, actor);
  const body = await boundedJson(request);
  if (new URL(request.url).pathname === "/migration/challenge") {
    if (!object(body) || body.new !== caller)
      throw new ProtocolError(403, "OMEW_ACTOR_MISMATCH");
    return protocolResponse(
      await issueMigrationChallenge(env, String(body.old), String(body.new)),
    );
  }
  return protocolResponse(await acceptMigrationProof(env, body, caller));
}
export async function announceMigration(
  env: Env,
  actor: string,
  proof: JsonObject,
  peers: string[],
): Promise<Envelope> {
  const state = await env.DB.prepare(
    "SELECT * FROM account_migrations WHERE old_actor=? AND new_actor=?",
  )
    .bind(proof.old, actor)
    .first<MigrationRow>();
  if (!state) throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const acceptedProof = JSON.parse(state.proof) as JsonObject;
  const candidate = state.announcement
    ? (JSON.parse(state.announcement) as Envelope)
    : await newEvent(
        env,
        "user.moved",
        {
          old: proof.old,
          new: actor,
          mode: state.mode,
          proof: acceptedProof,
          effective_at: state.effective_at,
          ...(acceptedProof.home_release
            ? { home_release: acceptedProof.home_release }
            : {}),
        },
        { actor },
      );
  if (!state.announcement)
    await env.DB.prepare(
      "UPDATE account_migrations SET announcement=? WHERE old_actor=? AND new_actor=? AND announcement IS NULL",
    )
      .bind(JSON.stringify(candidate), proof.old, actor)
      .run();
  const stored = await env.DB.prepare(
    "SELECT announcement FROM account_migrations WHERE old_actor=? AND new_actor=?",
  )
    .bind(proof.old, actor)
    .first<{ announcement: string }>();
  const event = JSON.parse(stored!.announcement) as Envelope;
  await acceptMigrationAnnouncement(env, event);
  for (const peer of peers) await queueDelivery(env, peer, event);
  return event;
}
