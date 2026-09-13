import { describe, expect, it } from "vitest";
import { getInstanceBranding } from "../server/src/config";

function envWith(vars: Record<string, string | undefined>): Env {
  return vars as unknown as Env;
}

describe("getInstanceBranding", () => {
  it("keeps generic deployments on the default logo and enabled capabilities", () => {
    expect(getInstanceBranding(envWith({}))).toEqual({
      instance_name: "OMEW",
      logo_url: null,
      emotes_enabled: true,
      builtin_emotes_enabled: true,
      reactions_enabled: true,
      builtin_reactions_enabled: true,
      art_assets_enabled: true,
    });
  });

  it("parses a deployment logo and capability switches", () => {
    expect(
      getInstanceBranding(
        envWith({
          INSTANCE_NAME: "论坛",
          INSTANCE_LOGO_URL: "https://stardustinfinity.top/favicon.svg",
          ENABLE_EMOTES: "0",
          USE_BUILTIN_EMOTES: "0",
          ENABLE_REACTIONS: "false",
          USE_BUILTIN_REACTIONS: "0",
          USE_ART_ASSETS: "0",
        }),
      ),
    ).toEqual({
      instance_name: "论坛",
      logo_url: "https://stardustinfinity.top/favicon.svg",
      emotes_enabled: false,
      builtin_emotes_enabled: false,
      reactions_enabled: false,
      builtin_reactions_enabled: false,
      art_assets_enabled: false,
    });
  });

  it("keeps bundled emotes and reactions independent of general art assets", () => {
    const branding = getInstanceBranding(
      envWith({ USE_ART_ASSETS: "0", USE_BUILTIN_EMOTES: "1", USE_BUILTIN_REACTIONS: "1" }),
    );
    expect(branding).toMatchObject({
      art_assets_enabled: false,
      builtin_emotes_enabled: true,
      builtin_reactions_enabled: true,
    });
  });

  it("can disable bundled reactions without disabling bundled emotes", () => {
    const branding = getInstanceBranding(
      envWith({ USE_BUILTIN_EMOTES: "1", USE_BUILTIN_REACTIONS: "0", ENABLE_REACTIONS: "1" }),
    );
    expect(branding).toMatchObject({
      builtin_emotes_enabled: true,
      builtin_reactions_enabled: false,
      reactions_enabled: true,
    });
  });

  it("rejects unsafe non-HTTPS external logo values", () => {
    expect(getInstanceBranding(envWith({ INSTANCE_LOGO_URL: "http://example.com/logo.svg" })).logo_url).toBeNull();
    expect(getInstanceBranding(envWith({ INSTANCE_LOGO_URL: "javascript:alert(1)" })).logo_url).toBeNull();
    expect(getInstanceBranding(envWith({ INSTANCE_LOGO_URL: "/custom-logo.svg" })).logo_url).toBe("/custom-logo.svg");
  });
});
