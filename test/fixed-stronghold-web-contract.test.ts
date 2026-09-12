import { describe, expect, it } from "vitest";
import app from "../web/src/App.vue?raw";
import chatPane from "../web/src/components/ChatPane.vue?raw";
import emptyState from "../web/src/components/EmptyState.vue?raw";
import landingPage from "../web/src/components/LandingPage.vue?raw";
import mobileNavBar from "../web/src/components/MobileNavBar.vue?raw";
import nodeRail from "../web/src/components/NodeRail.vue?raw";
import postModal from "../web/src/components/PostModal.vue?raw";
import useEmotes from "../web/src/composables/useEmotes.ts?raw";

describe("fixed stronghold web contract", () => {
  it("routes a configured fixed instance into its stronghold instead of rendering the landing page", () => {
    expect(app).toContain("fixed_stronghold");
    expect(app).toContain("installRoute(fixed.id, fixed.slug)");
    expect(app).toContain("!instanceConfigLoading.value && !fixedStronghold.value");
  });

  it("hides discovery and creation controls in fixed mode", () => {
    expect(nodeRail).toContain("auth.isAuthenticated.value && !fixedStronghold");
    expect(nodeRail).toContain("fixedStronghold ? `/a/${encodeURIComponent(fixedStronghold.slug)}` : '/'");
  });

  it("uses the configured logo and gates optional interaction features", () => {
    expect(app).toContain("syncFavicon")
    expect(nodeRail).toContain("art_assets_enabled !== false ? '/favicon.svg' : null")
    expect(mobileNavBar).toContain("art_assets_enabled !== false ? '/favicon.svg' : null")
    expect(chatPane).toContain("emotesEnabled")
    expect(chatPane).toContain("reactionsEnabled")
    expect(postModal).toContain("reactionsEnabled")
    expect(useEmotes).toContain("builtin_emotes_enabled")
    expect(landingPage).toContain("v-if=\"artAssetsEnabled\"")
    expect(emptyState).toContain("v-if=\"image\"")
  });
});
