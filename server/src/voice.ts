import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { instanceDomain } from "./types";

const VOICE_TOKEN_TTL_SECONDS = 90;

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
  if (!env.LIVEKIT_URL && !env.LIVEKIT_API_KEY && !env.LIVEKIT_API_SECRET) return;
  const config = liveKitConfig(env);
  const room = await liveKitRoomName(env, roomRef);
  const client = new RoomServiceClient(config.serverUrl, config.apiKey, config.apiSecret);
  await client.removeParticipant(room, actor, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1) });
}

export async function revokeVoiceRoomParticipants(env: Env, roomRef: string): Promise<void> {
  if (!env.LIVEKIT_URL && !env.LIVEKIT_API_KEY && !env.LIVEKIT_API_SECRET) return;
  const config = liveKitConfig(env);
  const room = await liveKitRoomName(env, roomRef);
  const client = new RoomServiceClient(config.serverUrl, config.apiKey, config.apiSecret);
  const participants = await client.listParticipants(room);
  const revokeTokenTs = BigInt(Math.floor(Date.now() / 1000) + 1);
  await Promise.all(participants.map((participant) =>
    client.removeParticipant(room, participant.identity, { revokeTokenTs })
  ));
}

export async function revokeVoiceParticipantFromStronghold(env: Env, strongholdId: string, actor: string): Promise<void> {
  const rooms = await env.STRONGHOLD_DO.getByName(strongholdId).listRooms();
  for (const room of rooms) {
    if (room.type !== "channel" || !JSON.parse(room.capabilities_json).includes("voice")) continue;
    await revokeVoiceParticipant(env, `${strongholdId}/ch/${room.res_id}`, actor);
  }
}
