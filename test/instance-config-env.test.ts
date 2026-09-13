import { describe, expect, it } from "vitest";
import { getInstanceConfig, getSsoConfig, isValidOidcIssuer } from "../server/src/config";

// m0-protocol §7.9: instance policy is deployment env config, parsed tolerantly
// (server/src/config.ts) - a malformed var degrades to its default rather than
// throwing/500ing the instance. Pure parsing logic, no D1/HTTP involved, so this
// exercises config.ts directly with hand-built env objects rather than going
// through the API surface (covered separately by the GET/PATCH
// /api/admin/instance/config tests in the other suites).

function envWith(vars: Record<string, string | undefined>): Env {
  return vars as unknown as Env;
}

describe("getInstanceConfig: defaults", () => {
  it("falls back to the documented safe defaults when every var is unset", () => {
    expect(getInstanceConfig(envWith({}))).toEqual({
      instance_mode: "multi",
      root_stronghold: null,
      allow_root: true,
      root_requirements: [],
      trusted_identity_servers: ["*"],
      max_file_bytes: 10_485_760,
      user_storage_quota_bytes: 209_715_200,
      federation_peers: [],
      stronghold_creation_policy: "restricted",
      stronghold_creators: [],
      personal_settings_sections: ["profile", "security", "appearance"],
      allow_guest_browsing: true,
    });
  });
});

describe("getInstanceConfig: boolean parsing", () => {
  it("parses '0'/'false' as false and '1'/'true' as true, case-insensitively", () => {
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "0" })).allow_root).toBe(false);
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "false" })).allow_root).toBe(false);
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "FALSE" })).allow_root).toBe(false);
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "1" })).allow_root).toBe(true);
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "TRUE" })).allow_root).toBe(true);
    expect(getInstanceConfig(envWith({ ALLOW_GUEST_BROWSING: "0" })).allow_guest_browsing).toBe(false);
  });

  it("falls back to the default on a malformed boolean instead of throwing", () => {
    expect(() => getInstanceConfig(envWith({ ALLOW_ROOT: "maybe" }))).not.toThrow();
    expect(getInstanceConfig(envWith({ ALLOW_ROOT: "maybe" })).allow_root).toBe(true);
  });
});

describe("getInstanceConfig: comma-separated list parsing", () => {
  it("splits and trims, dropping empty entries from stray commas/whitespace", () => {
    expect(getInstanceConfig(envWith({ ROOT_REQUIREMENTS: " email , code ,, " })).root_requirements).toEqual([
      "email",
      "code",
    ]);
  });

  it("drops unrecognized root_requirements entries instead of throwing", () => {
    expect(getInstanceConfig(envWith({ ROOT_REQUIREMENTS: "email,bogus,code" })).root_requirements).toEqual([
      "email",
      "code",
    ]);
  });

  it("treats an explicit empty string as an empty list, not 'unset'", () => {
    expect(getInstanceConfig(envWith({ FEDERATION_PEERS: "" })).federation_peers).toEqual([]);
    // Contrast: unset falls back to the default instead.
    expect(getInstanceConfig(envWith({})).trusted_identity_servers).toEqual(["*"]);
  });

  it("parses the available personal settings allowlist and drops duplicates or unknown values", () => {
    expect(getInstanceConfig(envWith({ PERSONAL_SETTINGS_SECTIONS: "appearance,profile,appearance,unknown" })).personal_settings_sections)
      .toEqual(["appearance", "profile"]);
    expect(getInstanceConfig(envWith({ PERSONAL_SETTINGS_SECTIONS: "" })).personal_settings_sections).toEqual([]);
  });
});

describe("getInstanceConfig: enum parsing", () => {
  it("accepts single mode and a valid root stronghold slug", () => {
    expect(getInstanceConfig(envWith({ INSTANCE_MODE: "single", ROOT_STRONGHOLD: "main-lobby" }))).toMatchObject({
      instance_mode: "single",
      root_stronghold: "main-lobby",
    });
  });

  it("falls back to multi mode and no root for malformed single-mode settings", () => {
    expect(getInstanceConfig(envWith({ INSTANCE_MODE: "single", ROOT_STRONGHOLD: "Not Valid" }))).toMatchObject({
      instance_mode: "single",
      root_stronghold: null,
    });
    expect(getInstanceConfig(envWith({ INSTANCE_MODE: "invalid", ROOT_STRONGHOLD: "root" })).instance_mode).toBe("multi");
  });

  it("falls back to 'restricted' on an unrecognized stronghold_creation_policy", () => {
    expect(getInstanceConfig(envWith({ STRONGHOLD_CREATION: "invited-only" })).stronghold_creation_policy).toBe("restricted");
  });

  it("accepts every documented enum value", () => {
    expect(getInstanceConfig(envWith({ STRONGHOLD_CREATION: "restricted" })).stronghold_creation_policy).toBe("restricted");
    expect(getInstanceConfig(envWith({ STRONGHOLD_CREATION: "application" })).stronghold_creation_policy).toBe("application");
  });
});

describe("getSsoConfig", () => {
  it("requires a complete OIDC client configuration before reporting SSO as configured", () => {
    expect(getSsoConfig(envWith({ SSO_MODE: "optional", SSO_ISSUER: "https://identity.example", SSO_CLIENT_ID: "omew" }))).toMatchObject({
      mode: "optional",
      configured: false,
    });
    expect(getSsoConfig(envWith({
      SSO_MODE: "required",
      SSO_ISSUER: "https://identity.example",
      SSO_CLIENT_ID: "omew",
      SSO_CLIENT_SECRET: "secret",
    }))).toMatchObject({ mode: "required", configured: true });
  });

  it("locks the SSO session only for embedded required-mode instances", () => {
    expect(getSsoConfig(envWith({ SSO_MODE: "required", EMBED_ORIGIN: "https://host.example" })).session_locked).toBe(true);
    expect(getSsoConfig(envWith({ SSO_MODE: "required" })).session_locked).toBe(false);
    expect(getSsoConfig(envWith({ SSO_MODE: "optional", EMBED_ORIGIN: "https://host.example" })).session_locked).toBe(false);
  });

  it("accepts HTTPS issuers and loopback HTTP only for local development", () => {
    expect(isValidOidcIssuer("https://identity.example")).toBe(true);
    expect(isValidOidcIssuer("http://localhost:8787")).toBe(true);
    expect(isValidOidcIssuer("http://identity.example")).toBe(false);
    expect(isValidOidcIssuer("https://identity.example?tenant=one")).toBe(false);
  });
});

describe("getInstanceConfig: positive-integer parsing", () => {
  it("falls back to the default on a non-numeric, zero, or negative value", () => {
    expect(getInstanceConfig(envWith({ MAX_FILE_BYTES: "not-a-number" })).max_file_bytes).toBe(10_485_760);
    expect(getInstanceConfig(envWith({ MAX_FILE_BYTES: "0" })).max_file_bytes).toBe(10_485_760);
    expect(getInstanceConfig(envWith({ MAX_FILE_BYTES: "-5" })).max_file_bytes).toBe(10_485_760);
  });

  it("parses a valid positive integer string", () => {
    expect(getInstanceConfig(envWith({ MAX_FILE_BYTES: "5000" })).max_file_bytes).toBe(5000);
    expect(getInstanceConfig(envWith({ USER_STORAGE_QUOTA_BYTES: "123456" })).user_storage_quota_bytes).toBe(123456);
  });
});
