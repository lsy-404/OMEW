import { describe, expect, it } from "vitest";
import app from "../web/src/App.vue?raw";
import authForm from "../web/src/components/AuthForm.vue?raw";
import client from "../web/src/api/client.ts?raw";
import auth from "../web/src/composables/useAuth.ts?raw";

describe("OMEW SSO web contract", () => {
  it("offers SSO in optional mode and keeps required mode SSO-only", () => {
    expect(authForm).toContain("ssoAvailable");
    expect(authForm).toContain("ssoRequired");
    expect(authForm).toContain("使用 ${instanceConfig?.sso_provider_name || 'SSO'} 登录");
    expect(authForm).toContain("!ssoRequired");
  });

  it("finishes the one-time callback code without a cross-site bridge", () => {
    expect(client).toContain("/api/auth/oidc/complete");
    expect(auth).toContain("sso_complete");
    expect(app).not.toContain("postMessage");
    expect(app).not.toContain("STAR_DUST");
  });

  it("removes global navigation rails from single mode while keeping the content shell", () => {
    expect(app).toContain("<NodeRail v-if=\"!singleMode\" />");
    expect(app).toContain("<MobileNavBar v-if=\"!singleMode\" />");
    expect(app).toContain("shell__body--single");
  });
});
