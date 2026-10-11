import { env } from "cloudflare:test";
import { jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { apiRequest, ensureMigrated, sessionToken, TEST_SECRET } from "./helpers";

const LIVEKIT_API_KEY = "test-livekit-key";
const LIVEKIT_API_SECRET = "test-livekit-secret-for-unit-tests";
let sequence = 0;

async function verifyLiveKitToken(token: string) {
  return jwtVerify(token, new TextEncoder().encode(LIVEKIT_API_SECRET), { algorithms: ["HS256"] });
}

async function voiceRoom(visibility: "public" | "private" = "public") {
  const suffix = `${Date.now()}${sequence++}`;
  const actor = `@voiceowner${suffix}:local`;
  const token = await sessionToken(actor);
  const id = `voice${suffix}`;
  const stronghold = env.STRONGHOLD_DO.getByName(id);
  await stronghold.initConfig(id, "Voice test", visibility, actor);
  await stronghold.createRoom("general", "channel", "General", ["text", "voice"], false);
  return { id, actor, token, stronghold };
}

beforeAll(async () => {
  await ensureMigrated();
  env.LIVEKIT_URL = "http://localhost:7880";
  env.LIVEKIT_API_KEY = LIVEKIT_API_KEY;
  env.LIVEKIT_API_SECRET = LIVEKIT_API_SECRET;
});

describe("LiveKit voice token route", () => {
  it("issues a short room-scoped audio token only for a voice-capable room", async () => {
    const { id, actor, token, stronghold } = await voiceRoom();
    const response = await apiRequest(`/stronghold/${id}/rooms/general/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as { token: string; url: string; exp: number; can_publish: boolean };
    const { payload } = await verifyLiveKitToken(result.token);
    const room = await stronghold.getRoom("general");
    expect(result.url).toBe("ws://localhost:7880");
    expect(result.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 120);
    expect(payload.sub).toBe(actor);
    expect(payload.video).toMatchObject({ room: expect.any(String), roomJoin: true, canPublish: true, canSubscribe: true });
    expect(room?.capabilities_json).toContain("voice");
  });

  it("keeps denied members listen-only and blocks visitors without room membership", async () => {
    const { id, stronghold } = await voiceRoom();
    const member = `@voicemember${Date.now()}${sequence++}:local`;
    await sessionToken(member);
    await stronghold.addMember(member, "member");
    await stronghold.updateMember(member, { deny: 1 });

    const listenOnly = await apiRequest(`/stronghold/${id}/rooms/general/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sessionToken(member)}` },
    });
    expect(listenOnly.status).toBe(200);
    const result = (await listenOnly.json()) as { token: string; can_publish: boolean };
    const { payload } = await verifyLiveKitToken(result.token);
    expect(result.can_publish).toBe(false);
    expect(payload.video).toMatchObject({ canPublish: false, canSubscribe: true });

    const visitor = `@voicevisitor${Date.now()}${sequence++}:local`;
    const denied = await apiRequest(`/stronghold/${id}/rooms/general/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sessionToken(visitor)}` },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("OMEW_BANNED");
  });

  it("does not issue tokens for rooms without voice or inaccessible private rooms", async () => {
    const { id, token, stronghold } = await voiceRoom("private");
    await stronghold.createRoom("quiet", "channel", "Quiet", ["text"], false);
    await stronghold.createRoom("moderated", "channel", "Moderated", ["text", "voice"], true);
    const section = await stronghold.createRoom("topics", "section", "Topics", ["text", "voice"], false);
    expect(section.capabilities_json).not.toContain("voice");
    const disabled = await apiRequest(`/stronghold/${id}/rooms/quiet/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(disabled.status).toBe(404);

    const member = `@voiceoutsider${Date.now()}${sequence++}:local`;
    await sessionToken(member);
    await stronghold.addMember(member, "member");
    const restrictedDenied = await apiRequest(`/stronghold/${id}/rooms/moderated/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sessionToken(member)}` },
    });
    expect(restrictedDenied.status).toBe(404);

    const visitor = await sessionToken(`@voiceoutside${Date.now()}${sequence++}:local`);
    const privateDenied = await apiRequest(`/stronghold/${id}/rooms/general/voice-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${visitor}` },
    });
    expect(privateDenied.status).toBe(403);

    const noSession = await apiRequest(`/stronghold/${id}/rooms/general/voice-token`, { method: "POST" });
    expect(noSession.status).toBe(401);
  });
});
