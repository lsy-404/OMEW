import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../server/src/auth";
import { apiRequest, ensureMigrated } from "./helpers";

const STAR_DUST_SECRET = "star-dust-sso-test-secret";

beforeAll(async () => {
  await ensureMigrated();
  env.STAR_DUST_SSO_SECRET = STAR_DUST_SECRET;
});

describe("star-dust-fans identity bridge", () => {
  it("upserts the external identity and returns a normal OMEW session", async () => {
    const bridgeToken = await signToken(
      {
        typ: "star_dust_sso",
        iss: "stardustinfinity.top",
        aud: "omew.stardustinfinity.top",
        sub: "integration-user-1",
        username: "星尘用户",
        email: "star-user@example.com",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      STAR_DUST_SECRET
    );

    const res = await apiRequest("/api/integration/star-dust/session", {
      method: "POST",
      body: JSON.stringify({ token: bridgeToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { username: string; actor: string } };
    expect(body.token).toMatch(/\./);
    expect(body.user).toMatchObject({ username: "star-integration-user-1", actor: "@star-integration-user-1:local" });
    expect(await env.DB.prepare("SELECT display_name, email FROM users WHERE localpart = ?").bind("star-integration-user-1").first())
      .toEqual({ display_name: "星尘用户", email: "star-user@example.com" });
  });

  it("rejects a bridge token signed for another audience", async () => {
    const bridgeToken = await signToken(
      {
        typ: "star_dust_sso",
        iss: "stardustinfinity.top",
        aud: "other.example",
        sub: "integration-user-2",
        username: "wrong-audience",
        email: null,
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      STAR_DUST_SECRET
    );
    const res = await apiRequest("/api/integration/star-dust/session", {
      method: "POST",
      body: JSON.stringify({ token: bridgeToken }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "SSO_INVALID" });
  });
});
