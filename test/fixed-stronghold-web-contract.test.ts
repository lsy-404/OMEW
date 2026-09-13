import { describe, expect, it } from "vitest";
import app from "../web/src/App.vue?raw";
import chatPane from "../web/src/components/ChatPane.vue?raw";
import emptyState from "../web/src/components/EmptyState.vue?raw";
import landingPage from "../web/src/components/LandingPage.vue?raw";
import mobileNavBar from "../web/src/components/MobileNavBar.vue?raw";
import memberInfoCard from "../web/src/components/MemberInfoCard.vue?raw";
import nodeRail from "../web/src/components/NodeRail.vue?raw";
import postModal from "../web/src/components/PostModal.vue?raw";
import rightColumn from "../web/src/components/RightColumn.vue?raw";
import serverAdminModal from "../web/src/components/ServerAdminModal.vue?raw";
import strongholdAdminModal from "../web/src/components/StrongholdAdminModal.vue?raw";
import useEmotes from "../web/src/composables/useEmotes.ts?raw";
import indexHtml from "../web/index.html?raw";

describe("single stronghold web contract", () => {
  it("does not render the landing page in single mode", () => {
    expect(app).toContain("instanceConfig.value?.instance_mode === 'single'");
    expect(app).toContain("!singleMode.value");
    expect(app).toContain("showInstanceLoading");
  });

  it("hides the global navigation rails in single mode", () => {
    expect(app).toContain("<NodeRail v-if=\"!singleMode\" />");
    expect(app).toContain("<MobileNavBar v-if=\"!singleMode\" />");
    expect(nodeRail).toContain("发现据点");
  });

  it("uses the configured logo and gates optional interaction features", () => {
    expect(app).toContain("syncFavicon")
    expect(app).toContain("const faviconSrc = computed(() => (artAssetsEnabled.value ? logoSrc.value : null))")
    expect(app).toContain("link?.remove()")
    expect(nodeRail).toContain("art_assets_enabled !== false ? '/favicon.svg' : null")
    expect(mobileNavBar).toContain("art_assets_enabled !== false ? '/favicon.svg' : null")
    expect(chatPane).toContain("emotesEnabled")
    expect(chatPane).toContain("reactionsEnabled")
    expect(postModal).toContain("reactionsEnabled")
    expect(useEmotes).toContain("builtin_emotes_enabled")
    expect(useEmotes).not.toContain("art_assets_enabled")
    expect(landingPage).toContain("v-if=\"artAssetsEnabled\"")
    expect(emptyState).toContain("v-if=\"image\"")
    expect(indexHtml).not.toContain('rel="icon"')
  });

  it("automatically starts SSO and hides logout for a locked embedded session", () => {
    expect(app).toContain("instanceConfig.value?.sso_session_locked === true")
    expect(app).toContain("/api/auth/oidc/start?return_to=")
    expect(app).toContain("正在使用 {{ instanceConfig?.sso_provider_name || '统一身份' }} 登录…")
    expect(rightColumn).toContain("instanceConfig.value?.sso_session_locked ? []")
  });

  it("renders username aliases instead of internal actor localparts", () => {
    expect(memberInfoCard).not.toContain('class="member-info-card__actor"')
    expect(strongholdAdminModal).toContain('<span class="member-row__actor">@{{ member.username }}</span>')
    expect(serverAdminModal).toContain('<span class="user-row__name">{{ user.username }}</span>')
  });
});
