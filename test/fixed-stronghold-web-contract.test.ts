import { describe, expect, it } from "vitest";
import app from "../web/src/App.vue?raw";
import chatPane from "../web/src/components/ChatPane.vue?raw";
import emptyState from "../web/src/components/EmptyState.vue?raw";
import landingPage from "../web/src/components/LandingPage.vue?raw";
import mobileNavBar from "../web/src/components/MobileNavBar.vue?raw";
import nodeRail from "../web/src/components/NodeRail.vue?raw";
import postModal from "../web/src/components/PostModal.vue?raw";
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
    expect(landingPage).toContain("v-if=\"artAssetsEnabled\"")
    expect(emptyState).toContain("v-if=\"image\"")
    expect(indexHtml).not.toContain('rel="icon"')
  });
});
