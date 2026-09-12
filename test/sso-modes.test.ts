import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { apiRequest, ensureMigrated, sessionToken } from "./helpers";

describe("SSO authentication modes", () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  afterAll(() => {
    env.SSO_MODE = "disabled";
    env.SSO_ISSUER = "";
    env.SSO_CLIENT_ID = "";
    env.SSO_CLIENT_SECRET = undefined;
    env.SSO_PROVIDER_NAME = "";
  });

  it("keeps the OIDC entry point disabled by default", async () => {
    env.SSO_MODE = "disabled";
    const response = await apiRequest("/api/auth/oidc/start");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "SSO_DISABLED" });
  });

  it("fails closed when required SSO is not configured and rejects local login", async () => {
    env.SSO_MODE = "required";
    env.SSO_ISSUER = "";
    env.SSO_CLIENT_ID = "";
    env.SSO_CLIENT_SECRET = undefined;

    const start = await apiRequest("/api/auth/oidc/start");
    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({ error: "SSO_NOT_CONFIGURED" });

    const register = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({ username: "blocked-local", password: "password123" }),
    });
    expect(register.status).toBe(403);
    expect(await register.json()).toEqual({ error: "SSO_REQUIRED" });
  });

  it("does not accept a local session while SSO-only mode is active", async () => {
    env.SSO_MODE = "required";
    const token = await sessionToken("@sso-only-user:local");
    const response = await apiRequest("/api/me/strongholds", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_REQUIRED" });
  });
});
