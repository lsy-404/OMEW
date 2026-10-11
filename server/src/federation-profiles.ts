import canonicalize from "canonicalize";
import { base64UrlDecode, base64UrlEncode } from "./auth";
import { instanceDomain } from "./types";
import {
  canonicalActor,
  domain,
  keyId,
  object,
  ProtocolError,
  verifyObject,
  type JsonObject,
} from "./federation-codec";
import { signDocument } from "./federation-keys";

export interface OwnershipKey extends JsonObject {
  key_id: string;
  public_key: string;
  created_at: number;
  prev_key_id?: string;
  continuity_sig?: string;
}
export async function pinOwnership(
  env: Env,
  actor: string,
  current: unknown,
  history: unknown = [],
): Promise<OwnershipKey> {
  if (
    !canonicalActor(actor) ||
    !object(current) ||
    typeof current.public_key !== "string" ||
    (await keyId(current.public_key)) !== current.key_id ||
    !Number.isSafeInteger(current.created_at)
  )
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const entries = Array.isArray(history) ? history.filter(object) : [];
  if (entries.length > 100)
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  const { results } = await env.DB.prepare(
    "SELECT key_id,public_key,created_at,prev_key_id,continuity_sig FROM ownership_pins WHERE actor=? ORDER BY created_at,key_id",
  )
    .bind(actor)
    .all<OwnershipKey>();
  const known = new Map(results.map((entry) => [entry.key_id, entry]));
  const changes: OwnershipKey[] = [];
  for (const raw of [...entries, current].sort(
    (a, b) => Number(a.created_at) - Number(b.created_at),
  )) {
    const entry = raw as OwnershipKey;
    if (
      typeof entry.public_key !== "string" ||
      (await keyId(entry.public_key)) !== entry.key_id ||
      !Number.isSafeInteger(entry.created_at)
    )
      throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
    const pinned = known.get(entry.key_id);
    if (
      pinned &&
      (pinned.public_key !== entry.public_key ||
        pinned.created_at !== entry.created_at ||
        (pinned.prev_key_id ?? null) !== (entry.prev_key_id ?? null))
    )
      throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
    if (!pinned && known.size > 0) {
      const previous = known.get(String(entry.prev_key_id));
      if (
        !previous ||
        !(await verifyObject(
          "openmew/ownership/v1",
          {
            actor,
            key_id: entry.key_id,
            public_key: entry.public_key,
            created_at: entry.created_at,
            prev_key_id: entry.prev_key_id,
            sig: entry.continuity_sig,
          },
          previous.public_key,
        ))
      )
        throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
      if (results.at(-1) && entry.created_at <= results.at(-1)!.created_at)
        throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
    }
    known.set(entry.key_id, entry);
    if (!pinned) changes.push(entry);
  }
  const tail = [...known.values()]
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1)!;
  if (tail.key_id !== current.key_id)
    throw new ProtocolError(403, "OMEW_OWNERSHIP_PROOF_INVALID");
  if (changes.length)
    await env.DB.batch(
      changes.map((entry) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO ownership_pins(actor,key_id,public_key,created_at,prev_key_id,continuity_sig) VALUES (?,?,?,?,?,?)",
        ).bind(
          actor,
          entry.key_id,
          entry.public_key,
          entry.created_at,
          entry.prev_key_id ?? null,
          entry.continuity_sig ?? null,
        ),
      ),
    );
  return tail;
}
export async function localProfile(
  env: Env,
  actor: string,
): Promise<JsonObject> {
  if (domain(actor) !== instanceDomain(env))
    throw new ProtocolError(404, "OMEW_NOT_FOUND");
  const row = await env.DB.prepare(
    "SELECT localpart,display_name,avatar,bio,created_at,status,ownership_pubkey FROM users WHERE localpart=?",
  )
    .bind(actor.slice(1, actor.indexOf(":")))
    .first<{
      localpart: string;
      display_name: string;
      avatar: string | null;
      bio: string | null;
      created_at: number;
      status: string;
      ownership_pubkey: string | null;
    }>();
  if (!row) throw new ProtocolError(404, "OMEW_NOT_FOUND");
  const fields: JsonObject = {
    v: 1,
    actor,
    display_name: row.display_name.normalize("NFC"),
    created_at: row.created_at,
    status: row.status === "active" ? "active" : "deactivated",
  };
  if (row.avatar) fields.avatar = row.avatar.normalize("NFC");
  if (row.bio) fields.bio = row.bio.normalize("NFC");
  const ownershipMeta = await env.DB.prepare(
    "SELECT ownership_entry FROM federation_local_profile WHERE actor=?",
  )
    .bind(actor)
    .first<{ ownership_entry: string | null }>();
  if (row.ownership_pubkey) {
    const publicKey = base64UrlEncode(base64UrlDecode(row.ownership_pubkey));
    fields.ownership_key = ownershipMeta?.ownership_entry
      ? JSON.parse(ownershipMeta.ownership_entry)
      : {
          key_id: await keyId(publicKey),
          public_key: publicKey,
          created_at: row.created_at,
        };
    await pinOwnership(env, actor, fields.ownership_key);
  }
  const digest = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalize(fields)),
      ),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO federation_local_profile(actor,version,digest) VALUES (?,0,?) ON CONFLICT(actor) DO UPDATE SET version=version+CASE WHEN digest!=excluded.digest THEN 1 ELSE 0 END,digest=excluded.digest",
  )
    .bind(actor, digest)
    .run();
  const meta = await env.DB.prepare(
    "SELECT version,moved_to,aliases,key_history FROM federation_local_profile WHERE actor=?",
  )
    .bind(actor)
    .first<{
      version: number;
      moved_to: string | null;
      aliases: string;
      key_history: string;
    }>();
  fields.profile_version = meta!.version;
  fields.key_history = JSON.parse(meta!.key_history);
  fields.also_known_as = JSON.parse(meta!.aliases);
  if (meta!.moved_to) fields.moved_to = meta!.moved_to;
  return signDocument(env, "openmew/user-profile/v1", fields);
}
export async function upsertGuestProfile(
  env: Env,
  profile: JsonObject,
  origin: string,
): Promise<void> {
  if (
    !canonicalActor(profile.actor) ||
    domain(profile.actor) !== origin ||
    !Number.isSafeInteger(profile.profile_version) ||
    Number(profile.profile_version) < 0 ||
    !["active", "deactivated"].includes(String(profile.status))
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (profile.ownership_key)
    await pinOwnership(
      env,
      profile.actor,
      profile.ownership_key,
      profile.key_history,
    );
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO guest_identity(actor,registered_origin,profile_version,display_name,avatar,profile_status,ownership_key_json,key_history_json,first_seen_at,last_assertion_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET profile_version=excluded.profile_version,display_name=excluded.display_name,avatar=excluded.avatar,profile_status=excluded.profile_status,ownership_key_json=COALESCE(excluded.ownership_key_json,ownership_key_json),key_history_json=COALESCE(excluded.key_history_json,key_history_json) WHERE excluded.profile_version>guest_identity.profile_version",
  )
    .bind(
      profile.actor,
      origin,
      profile.profile_version,
      String(profile.display_name ?? profile.actor),
      profile.avatar ?? null,
      profile.status,
      profile.ownership_key ? JSON.stringify(profile.ownership_key) : null,
      profile.key_history ? JSON.stringify(profile.key_history) : null,
      now,
      now,
    )
    .run();
}

export async function receiveSideloads(
  env: Env,
  users: unknown,
): Promise<void> {
  if (!Array.isArray(users) || users.length > 100) return;
  for (const user of users) {
    if (
      !object(user) ||
      !canonicalActor(user.actor) ||
      !Number.isSafeInteger(user.profile_version) ||
      Number(user.profile_version) < 0 ||
      typeof user.display_name !== "string" ||
      user.display_name.length > 256
    )
      continue;
    const current = await env.DB.prepare(
      "SELECT profile_version FROM remote_users WHERE actor=?",
    )
      .bind(user.actor)
      .first<{ profile_version: number }>();
    if (current && current.profile_version >= Number(user.profile_version))
      continue;
    try {
      if (user.ownership_key)
        await pinOwnership(
          env,
          user.actor,
          user.ownership_key,
          user.key_history,
        );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "ownership.chain_rejected",
          actor: user.actor,
          error: String(error),
        }),
      );
      continue;
    }
    await env.DB.prepare(
      "INSERT INTO remote_users(actor,profile_version,display_name,avatar,ownership_key_json,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET profile_version=excluded.profile_version,display_name=excluded.display_name,avatar=excluded.avatar,ownership_key_json=COALESCE(excluded.ownership_key_json,remote_users.ownership_key_json),updated_at=excluded.updated_at WHERE excluded.profile_version>remote_users.profile_version",
    )
      .bind(
        user.actor,
        user.profile_version,
        user.display_name,
        typeof user.avatar === "string" ? user.avatar : null,
        user.ownership_key ? JSON.stringify(user.ownership_key) : null,
        Date.now(),
      )
      .run();
  }
}
