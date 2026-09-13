import { describe, expect, it } from "vitest";
import personalSettings from "../web/src/components/PersonalSettingsModal.vue?raw";
import rightColumn from "../web/src/components/RightColumn.vue?raw";

describe("personal settings capability contract", () => {
  it("filters the menu and modal tabs through the public instance definition", () => {
    expect(rightColumn).toContain("personal_settings_sections.length");
    expect(rightColumn).toContain("personalSettingsAvailable.value ?")
    expect(personalSettings).toContain("instanceConfig.value?.personal_settings_sections ?? []");
    expect(personalSettings).toContain("PANEL_TAB_DEFINITIONS.filter");
    expect(personalSettings).toContain("PANEL_TAB_OPTIONS.value.some");
  });

  it("does not load security settings when the security section is unavailable", () => {
    expect(personalSettings).toContain("option.value === 'security'");
    expect(personalSettings).toContain("void loadPasskeys()");
    expect(personalSettings).toContain('open && PANEL_TAB_OPTIONS.length');
  });
});
