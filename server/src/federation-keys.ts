import { base64UrlDecode, base64UrlEncode } from "./auth";
import { getInstanceConfig } from "./config";
import { instanceDomain } from "./types";
import {
  boundedJson,
  canonicalDomain,
  keyId,
  object,
  ProtocolError,
  QUEUE_MS,
  signObject,
  verifyObject,
  type JsonObject,
} from "./federation-codec";

export interface KeyEntry extends JsonObject {
  key_id: string;
  public_key: string;
  created_at: number;
  status: string;
  retired_at?: number | null;
  prev_key_id?: string | null;
  continuity_sig?: string | null;
  revoked_at?: number | null;
  revocation_sig?: string | null;
}
type OwnRow = KeyEntry & { instance: string; private_ciphertext: string };
export function configuredPeer(env: Env, peer: string): boolean {
  return (
    canonicalDomain(peer) &&
    getInstanceConfig(env).federation_peers.includes(peer)
  );
}
export async function assertPeer(env: Env, peer: string): Promise<void> {
  if (!configuredPeer(env, peer))
    throw new ProtocolError(403, "OMEW_UNKNOWN_ORIGIN");
  if (
    await env.DB.prepare(
      "SELECT origin FROM federation_blocklist WHERE origin = ?",
    )
      .bind(peer)
      .first()
  )
    throw new ProtocolError(403, "OMEW_PEER_BLOCKED");
}
export async function peerFetch(
  env: Env,
  peer: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await assertPeer(env, peer);
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new ProtocolError(400, "OMEW_MALFORMED");
  return fetch(`https://${peer}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
}
async function wrappingKey(env: Env, instance: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.DEV_TOKEN_SECRET),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(instance),
      info: new TextEncoder().encode("openmew/instance-key-custody/v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function sealPrivate(
  env: Env,
  instance: string,
  bytes: Uint8Array,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await wrappingKey(env, instance),
      bytes,
    ),
  );
  const output = new Uint8Array(iv.length + encrypted.length);
  output.set(iv);
  output.set(encrypted, iv.length);
  return base64UrlEncode(output);
}
async function openPrivate(env: Env, row: OwnRow): Promise<CryptoKey> {
  const bytes = base64UrlDecode(row.private_ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await wrappingKey(env, row.instance),
    bytes.slice(12),
  );
  return crypto.subtle.importKey("pkcs8", decrypted, "Ed25519", false, [
    "sign",
  ]);
}
async function createOwn(env: Env, previous?: OwnRow): Promise<OwnRow> {
  const instance = instanceDomain(env);
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPublic = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(rawPublic instanceof ArrayBuffer))
    throw new ProtocolError(500, "OMEW_INTERNAL");
  const publicKey = base64UrlEncode(new Uint8Array(rawPublic));
  const createdAt = Date.now();
  const id = await keyId(publicKey);
  const rawPrivate = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(rawPrivate instanceof ArrayBuffer))
    throw new ProtocolError(500, "OMEW_INTERNAL");
  const privateCiphertext = await sealPrivate(
    env,
    instance,
    new Uint8Array(rawPrivate),
  );
  const continuity = previous
    ? await signObject(
        "openmew/key-rotation/v1",
        {
          instance,
          key_id: id,
          public_key: publicKey,
          created_at: createdAt,
          prev_key_id: previous.key_id,
        },
        await openPrivate(env, previous),
      )
    : null;
  const statements: D1PreparedStatement[] = [];
  if (previous)
    statements.push(
      env.DB.prepare(
        "UPDATE own_signing_keys SET status='retired', retired_at=? WHERE instance=? AND key_id=? AND status='active'",
      ).bind(createdAt, instance, previous.key_id),
    );
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO own_signing_keys(instance,key_id,public_key,private_ciphertext,created_at,prev_key_id,continuity_sig) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      instance,
      id,
      publicKey,
      privateCiphertext,
      createdAt,
      previous?.key_id ?? null,
      continuity,
    ),
  );
  await env.DB.batch(statements);
  const current = await env.DB.prepare(
    "SELECT * FROM own_signing_keys WHERE instance=? AND status='active'",
  )
    .bind(instance)
    .first<OwnRow>();
  if (!current) throw new ProtocolError(503, "OMEW_KEY_UNKNOWN");
  return current;
}
export async function ownKey(env: Env): Promise<OwnRow> {
  return (
    (await env.DB.prepare(
      "SELECT * FROM own_signing_keys WHERE instance=? AND status='active'",
    )
      .bind(instanceDomain(env))
      .first<OwnRow>()) ?? createOwn(env)
  );
}
export async function signDocument(
  env: Env,
  prefix: string,
  fields: JsonObject,
): Promise<JsonObject> {
  const row = await ownKey(env);
  const doc = { ...fields, key_id: row.key_id };
  return {
    ...doc,
    sig: await signObject(prefix, doc, await openPrivate(env, row)),
  };
}
export async function ownKeys(env: Env): Promise<JsonObject> {
  await ownKey(env);
  const { results } = await env.DB.prepare(
    "SELECT key_id,public_key,created_at,status,retired_at,prev_key_id,continuity_sig,revoked_at,revocation_sig FROM own_signing_keys WHERE instance=? ORDER BY created_at,key_id",
  )
    .bind(instanceDomain(env))
    .all<KeyEntry>();
  return {
    v: 1,
    instance: instanceDomain(env),
    keys: results.map((row) => ({ ...row, alg: "Ed25519" })),
  };
}
export async function rotateOwnKey(env: Env): Promise<JsonObject> {
  await createOwn(env, await ownKey(env));
  return ownKeys(env);
}
export async function revokeOwnKey(env: Env, id: string): Promise<void> {
  const target = await env.DB.prepare(
    "SELECT * FROM own_signing_keys WHERE instance=? AND key_id=?",
  )
    .bind(instanceDomain(env), id)
    .first<OwnRow>();
  if (!target) throw new ProtocolError(404, "OMEW_KEY_UNKNOWN");
  if (target.status === "active") await rotateOwnKey(env);
  const time = Date.now();
  const signature = await signObject(
    "openmew/key-revocation/v1",
    { instance: target.instance, key_id: id, revoked_at: time },
    await openPrivate(env, target),
  );
  await env.DB.prepare(
    "UPDATE own_signing_keys SET status='revoked',revoked_at=?,revocation_sig=? WHERE instance=? AND key_id=?",
  )
    .bind(time, signature, target.instance, id)
    .run();
}
export async function pinPeerKeys(
  env: Env,
  peer: string,
  document: unknown,
): Promise<void> {
  await assertPeer(env, peer);
  if (
    !object(document) ||
    document.v !== 1 ||
    document.instance !== peer ||
    !Array.isArray(document.keys) ||
    document.keys.length === 0 ||
    document.keys.length > 100
  )
    throw new ProtocolError(400, "OMEW_MALFORMED");
  const { results: pinned } = await env.DB.prepare(
    "SELECT * FROM instance_keys WHERE instance=?",
  )
    .bind(peer)
    .all<KeyEntry>();
  const trusted = new Map(pinned.map((entry) => [entry.key_id, entry]));
  const accepted: KeyEntry[] = [];
  for (const value of [...document.keys].sort((a: unknown, b: unknown) =>
    object(a) && object(b) ? Number(a.created_at) - Number(b.created_at) : 0,
  )) {
    if (
      !object(value) ||
      typeof value.key_id !== "string" ||
      typeof value.public_key !== "string" ||
      value.alg !== "Ed25519" ||
      !Number.isSafeInteger(value.created_at) ||
      !["active", "retired", "revoked"].includes(String(value.status)) ||
      (await keyId(value.public_key)) !== value.key_id
    )
      throw new ProtocolError(400, "OMEW_MALFORMED");
    const entry = value as KeyEntry;
    const existing = trusted.get(entry.key_id);
    if (existing && existing.public_key !== entry.public_key)
      throw new ProtocolError(403, "OMEW_KEY_PIN_MISMATCH");
    if (!existing && pinned.length > 0) {
      const prev = trusted.get(String(entry.prev_key_id));
      if (
        !prev ||
        !(await verifyObject(
          "openmew/key-rotation/v1",
          {
            instance: peer,
            key_id: entry.key_id,
            public_key: entry.public_key,
            created_at: entry.created_at,
            prev_key_id: entry.prev_key_id,
            sig: entry.continuity_sig,
          },
          prev.public_key,
        ))
      )
        throw new ProtocolError(403, "OMEW_KEY_CONTINUITY_BROKEN");
    }
    if (existing?.status === "retired" && entry.status === "active")
      throw new ProtocolError(403, "OMEW_KEY_PIN_MISMATCH");
    if (existing?.status === "revoked" && entry.status !== "revoked")
      throw new ProtocolError(403, "OMEW_KEY_REVOKED");
    trusted.set(entry.key_id, entry);
    accepted.push(entry);
  }
  for (const entry of accepted)
    if (entry.status === "revoked") {
      if (
        !Number.isSafeInteger(entry.revoked_at) ||
        typeof entry.revocation_sig !== "string"
      )
        throw new ProtocolError(403, "OMEW_KEY_CONTINUITY_BROKEN");
      const input = {
        instance: peer,
        key_id: entry.key_id,
        revoked_at: entry.revoked_at,
        sig: entry.revocation_sig,
      };
      let valid = await verifyObject(
        "openmew/key-revocation/v1",
        input,
        entry.public_key,
      );
      for (const successor of accepted)
        if (!valid && successor.status === "active") {
          let ancestor: KeyEntry | undefined = successor;
          for (let steps = 0; ancestor && steps < 100; steps++) {
            if (ancestor.prev_key_id === entry.key_id) {
              valid = await verifyObject(
                "openmew/key-revocation/v1",
                input,
                successor.public_key,
              );
              break;
            }
            ancestor = trusted.get(String(ancestor.prev_key_id));
          }
        }
      if (!valid) throw new ProtocolError(403, "OMEW_KEY_CONTINUITY_BROKEN");
    }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO instances(instance,fetched_at) VALUES (?,?) ON CONFLICT(instance) DO UPDATE SET fetched_at=excluded.fetched_at",
    ).bind(peer, Date.now()),
    ...accepted.map((entry) =>
      env.DB.prepare(
        "INSERT INTO instance_keys(instance,key_id,public_key,created_at,status,retired_at,prev_key_id,continuity_sig,revoked_at,revocation_sig) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instance,key_id) DO UPDATE SET status=excluded.status,retired_at=excluded.retired_at,revoked_at=excluded.revoked_at,revocation_sig=excluded.revocation_sig",
      ).bind(
        peer,
        entry.key_id,
        entry.public_key,
        entry.created_at,
        entry.status,
        entry.retired_at ?? null,
        entry.prev_key_id ?? null,
        entry.continuity_sig ?? null,
        entry.revoked_at ?? null,
        entry.revocation_sig ?? null,
      ),
    ),
  ]);
}
export async function discoverPeer(env: Env, peer: string): Promise<void> {
  const response = await peerFetch(env, peer, "/.well-known/openmew/keys");
  if (!response.ok) throw new ProtocolError(503, "OMEW_KEY_UNKNOWN");
  await pinPeerKeys(env, peer, await boundedJson(response, 65_536, true));
}
export async function verifyPeerDocument(
  env: Env,
  prefix: string,
  fields: JsonObject,
  peer: string,
  now = Date.now(),
): Promise<void> {
  await assertPeer(env, peer);
  const row = await env.DB.prepare(
    "SELECT * FROM instance_keys WHERE instance=? AND key_id=?",
  )
    .bind(peer, String(fields.key_id))
    .first<KeyEntry>();
  if (
    !row ||
    (row.status === "retired" && now > Number(row.retired_at) + QUEUE_MS)
  )
    throw new ProtocolError(403, "OMEW_KEY_UNKNOWN");
  if (row.status === "revoked")
    throw new ProtocolError(403, "OMEW_KEY_REVOKED");
  if (!(await verifyObject(prefix, fields, row.public_key)))
    throw new ProtocolError(403, "OMEW_BAD_SIGNATURE");
}
