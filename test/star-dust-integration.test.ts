import { describe, expect, it } from "vitest";
import stardustConfig from "../server/wrangler.stardust.jsonc?raw";
import { apiRequest, ensureMigrated } from "./helpers";

describe("OMEW authentication boundary", () => {
  it("does not expose the former StarDust session bridge", async () => {
    await ensureMigrated();
    const response = await apiRequest("/api/integration/star-dust/session", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-session" }),
    });
    expect(response.status).toBe(404);
  });

  it("uses the StarDust provider in SSO-only mode without source-controlled credentials", () => {
    expect(stardustConfig).toContain('"SSO_MODE": "required"');
    expect(stardustConfig).toContain('"SSO_ISSUER": "https://stardustinfinity.top"');
    expect(stardustConfig).toContain('"SSO_CLIENT_ID": "stardust-omew"');
    expect(stardustConfig).toContain('"SSO_PROVIDER_NAME": "星尘粉丝站"');
    expect(stardustConfig).toContain('"SSO_USE_PAR": "1"');
    expect(stardustConfig).toContain("global_fetch_strictly_public");
    expect(stardustConfig).not.toContain("SSO_CLIENT_SECRET");
    expect(stardustConfig).not.toContain("STAR_DUST_SSO_SECRET");
  });
});
