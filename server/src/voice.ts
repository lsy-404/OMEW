import { AccessToken, RoomServiceClient, ServerError } from "livekit-server-sdk";
import { instanceDomain } from "./types";

const VOICE_TOKEN_TTL_SECONDS = 90;
const REVOCATION_LEASE_SECONDS = 30;
const REVOCATION_BATCH_SIZE = 50;
const MAX_REVOCATION_BACKOFF_SECONDS = 3600;

interface VoiceRevocation {
  job_key: string;
  room_ref: string;
  actor: string | null;
  revoke_token_ts: number;
  attempts: number;
}

export class VoiceUnavailableError extends Error {
  constructor() {
    super("LiveKit is not configured");
    this.name = "VoiceUnavailableError";
  }
}

function liveKitConfig(env: Env) {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) throw new VoiceUnavailableError();
  let url: URL;
  try {
    url = new URL(env.LIVEKIT_URL);
  } catch {
    throw new VoiceUnavailableError();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new VoiceUnavailableError();
  }
  return {
    serverUrl: url.origin,
    clientUrl: url.protocol === "https:" ? `wss://${url.host}` : `ws://${url.host}`,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
  };
}

export async function liveKitRoomName(env: Env, roomRef: string): Promise<string> {
  const input = new TextEncoder().encode(`openmew/voice/v1\0${instanceDomain(env)}\0${roomRef}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `om-${hex}`;
}

export async function createVoiceAccessToken(
  env: Env,
  roomRef: string,
  actor: string,
  displayName: string,
  canPublish: boolean,
): Promise<{ token: string; url: string; room: string; exp: number; can_publish: boolean }> {
  const config = liveKitConfig(env);
  const room = await liveKitRoomName(env, roomRef);
  const exp = Math.floor(Date.now() / 1000) + VOICE_TOKEN_TTL_SECONDS;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: actor,
    name: displayName,
    ttl: VOICE_TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish,
    canSubscribe: true,
    canPublishData: false,
  });
  return { token: await token.toJwt(), url: config.clientUrl, room, exp, can_publish: canPublish };
}

export async function revokeVoiceParticipant(env: Env, roomRef: string, actor: string): Promise<void> {
  if (!hasLiveKitConfig(env)) return;
  const job = await enqueueVoiceRevocation(env, roomRef, actor);
  await attemptVoiceRevocation(env, job);
}

export async function revokeVoiceRoomParticipants(env: Env, roomRef: string): Promise<void> {
  if (!hasLiveKitConfig(env)) return;
  const job = await enqueueVoiceRevocation(env, roomRef, null);
  await attemptVoiceRevocation(env, job);
}

export async function retryVoiceRevocations(env: Env): Promise<void> {
  if (!hasLiveKitConfig(env)) return;
  const now = Math.floor(Date.now() / 1000);
  const pending = await env.DB.prepare(
    "SELECT job_key, room_ref, actor, revoke_token_ts, attempts FROM voice_revocations WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
  ).bind(now, REVOCATION_BATCH_SIZE).all<VoiceRevocation>();
  await Promise.all(pending.results.map((job) => attemptVoiceRevocation(env, job)));
}

export async function revokeVoiceParticipantFromStronghold(env: Env, strongholdId: string, actor: string): Promise<void> {
  const rooms = await env.STRONGHOLD_DO.getByName(strongholdId).listRooms();
  for (const room of rooms) {
    if (room.type !== "channel" || !JSON.parse(room.capabilities_json).includes("voice")) continue;
    await revokeVoiceParticipant(env, `${strongholdId}/ch/${room.res_id}`, actor);
  }
}

function hasLiveKitConfig(env: Env): boolean {
  return Boolean(env.LIVEKIT_URL || env.LIVEKIT_API_KEY || env.LIVEKIT_API_SECRET);
}

async function enqueueVoiceRevocation(env: Env, roomRef: string, actor: string | null): Promise<VoiceRevocation> {
  const jobKey = actor === null ? `room:${roomRef}` : `participant:${roomRef}:${actor}`;
  const now = Math.floor(Date.now() / 1000);
  const revokeTokenTs = now + 1;
  await env.DB.prepare(
    "INSERT INTO voice_revocations (job_key, room_ref, actor, revoke_token_ts, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?) " +
    "ON CONFLICT(job_key) DO UPDATE SET revoke_token_ts = MAX(voice_revocations.revoke_token_ts, excluded.revoke_token_ts), attempts = 0, next_attempt_at = excluded.next_attempt_at",
  ).bind(jobKey, roomRef, actor, revokeTokenTs, now, now).run();
  const job = await env.DB.prepare(
    "SELECT job_key, room_ref, actor, revoke_token_ts, attempts FROM voice_revocations WHERE job_key = ?",
  ).bind(jobKey).first<VoiceRevocation>();
  if (!job) throw new Error("Failed to persist voice revocation");
  return job;
}

async function attemptVoiceRevocation(env: Env, job: VoiceRevocation): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const leaseUntil = now + REVOCATION_LEASE_SECONDS;
  const claimed = await env.DB.prepare(
    "UPDATE voice_revocations SET next_attempt_at = ? WHERE job_key = ? AND revoke_token_ts = ? AND next_attempt_at <= ?",
  ).bind(leaseUntil, job.job_key, job.revoke_token_ts, now).run();
  if (claimed.meta.changes === 0) return;

  try {
    const config = liveKitConfig(env);
    const room = await liveKitRoomName(env, job.room_ref);
    const client = new RoomServiceClient(config.serverUrl, config.apiKey, config.apiSecret);
    if (job.actor !== null) {
      await client.removeParticipant(room, job.actor, { revokeTokenTs: BigInt(job.revoke_token_ts) });
    } else {
      const participants = await client.listParticipants(room);
      await Promise.all(participants.map((participant) =>
        client.removeParticipant(room, participant.identity, { revokeTokenTs: BigInt(job.revoke_token_ts) })
      ));
    }
    await deleteVoiceRevocation(env, job);
  } catch (error) {
    if (isMissingRoomOrParticipant(error)) {
      await deleteVoiceRevocation(env, job);
      return;
    }
    const attempts = job.attempts + 1;
    const backoff = Math.min(MAX_REVOCATION_BACKOFF_SECONDS, 2 ** Math.min(job.attempts, 12));
    await env.DB.prepare(
      "UPDATE voice_revocations SET attempts = ?, next_attempt_at = ? WHERE job_key = ? AND revoke_token_ts = ?",
    ).bind(attempts, now + backoff, job.job_key, job.revoke_token_ts).run();
  }
}

async function deleteVoiceRevocation(env: Env, job: VoiceRevocation): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM voice_revocations WHERE job_key = ? AND revoke_token_ts = ?",
  ).bind(job.job_key, job.revoke_token_ts).run();
}

function isMissingRoomOrParticipant(error: unknown): boolean {
  return error instanceof ServerError && error.status === 404;
}
