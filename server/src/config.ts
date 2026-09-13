// m0-protocol §7.9: instance policy is deployment env config (wrangler.jsonc
// `vars`, overridable locally via .dev.vars - see .dev.vars.example), set by the
// operator at deploy time and MUST NOT be runtime-writable. This module is the
// single parse point: every var is a plain string (wrangler vars and .dev.vars
// agree on that), parsed tolerantly with a safe default on anything malformed
// rather than throwing - a typo'd env var should degrade, not 500 the instance.
//
// The instance_config D1 table (migrations 0002/0004/0006/0007) is no longer
// read for any of these fields - the table and its columns are left in place as
// archival/rollback-safe dead data, not dropped.

import type { InstanceConfig, InstanceMode, RootRequirement, SsoMode, StrongholdCreationPolicy } from "./types";

export interface InstanceBranding {
  instance_name: string;
  logo_url: string | null;
  emotes_enabled: boolean;
  builtin_emotes_enabled: boolean;
  reactions_enabled: boolean;
  art_assets_enabled: boolean;
}

export interface SsoRuntimeConfig {
  mode: SsoMode;
  issuer: string;
  client_id: string;
  client_secret: string;
  provider_name: string;
  configured: boolean;
  use_par: boolean;
  use_jarm: boolean;
  use_dpop: boolean;
  jar_private_jwk: string;
  session_locked: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const ROOT_REQUIREMENTS: readonly RootRequirement[] = ["email", "phone", "code"];
function parseRootRequirements(value: string | undefined): RootRequirement[] {
  return parseCsv(value, []).filter((v): v is RootRequirement =>
    (ROOT_REQUIREMENTS as readonly string[]).includes(v)
  );
}

const STRONGHOLD_CREATION_POLICIES: readonly StrongholdCreationPolicy[] = ["open", "restricted", "application"];
function parseStrongholdCreation(value: string | undefined): StrongholdCreationPolicy {
  const v = value?.trim();
  return v && (STRONGHOLD_CREATION_POLICIES as readonly string[]).includes(v) ? (v as StrongholdCreationPolicy) : "restricted";
}

const INSTANCE_MODES: readonly InstanceMode[] = ["multi", "single"];
const ROOT_STRONGHOLD_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function parseInstanceMode(value: string | undefined): InstanceMode {
  const mode = value?.trim();
  return mode && (INSTANCE_MODES as readonly string[]).includes(mode) ? mode as InstanceMode : "multi";
}

function parseRootStronghold(value: string | undefined): string | null {
  const root = value?.trim() ?? "";
  return ROOT_STRONGHOLD_RE.test(root) ? root : null;
}

const SSO_MODES: readonly SsoMode[] = ["disabled", "optional", "required"];
function parseSsoMode(value: string | undefined): SsoMode {
  const mode = value?.trim();
  return mode && (SSO_MODES as readonly string[]).includes(mode) ? mode as SsoMode : "disabled";
}

export function isValidOidcIssuer(value: string): boolean {
  try {
    const issuer = new URL(value);
    const localDevelopment = issuer.protocol === "http:" && (issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1");
    return (issuer.protocol === "https:" || localDevelopment) && !issuer.username && !issuer.password && !issuer.search && !issuer.hash;
  } catch {
    return false;
  }
}

export function getSsoConfig(env: Env): SsoRuntimeConfig {
  const mode = parseSsoMode(env.SSO_MODE);
  const issuer = (env.SSO_ISSUER?.trim() ?? "").replace(/\/+$/, "");
  const clientId = env.SSO_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.SSO_CLIENT_SECRET ?? "";
  const providerName = env.SSO_PROVIDER_NAME?.trim() || "SSO";
  return {
    mode,
    issuer,
    client_id: clientId,
    client_secret: clientSecret,
    provider_name: providerName,
    configured: isValidOidcIssuer(issuer) && clientId.length > 0 && clientSecret.length > 0,
    use_par: env.SSO_USE_PAR !== "0",
    use_jarm: env.SSO_USE_JARM === "1",
    use_dpop: env.SSO_USE_DPOP === "1",
    jar_private_jwk: env.SSO_JAR_PRIVATE_JWK?.trim() ?? "",
    session_locked: mode === "required" && Boolean(env.EMBED_ORIGIN?.trim()),
  };
}

export function getInstanceConfig(env: Env): InstanceConfig {
  return {
    instance_mode: parseInstanceMode(env.INSTANCE_MODE),
    root_stronghold: parseRootStronghold(env.ROOT_STRONGHOLD),
    allow_root: parseBool(env.ALLOW_ROOT, true),
    root_requirements: parseRootRequirements(env.ROOT_REQUIREMENTS),
    trusted_identity_servers: parseCsv(env.TRUSTED_IDENTITY_SERVERS, ["*"]),
    max_file_bytes: parsePositiveInt(env.MAX_FILE_BYTES, 10_485_760),
    user_storage_quota_bytes: parsePositiveInt(env.USER_STORAGE_QUOTA_BYTES, 209_715_200),
    federation_peers: parseCsv(env.FEDERATION_PEERS, []),
    stronghold_creation_policy: parseStrongholdCreation(env.STRONGHOLD_CREATION),
    stronghold_creators: parseCsv(env.STRONGHOLD_CREATORS, []),
    allow_guest_browsing: parseBool(env.ALLOW_GUEST_BROWSING, true),
  };
}

export function getInstanceBranding(env: Env): InstanceBranding {
  const instanceName = env.INSTANCE_NAME?.trim() ?? "";
  const logo = env.INSTANCE_LOGO_URL?.trim() ?? "";
  const logoUrl = logo.startsWith("/") || /^https:\/\//i.test(logo) ? logo : null;
  return {
    instance_name: instanceName.slice(0, 64) || "OMEW",
    logo_url: logoUrl,
    emotes_enabled: parseBool(env.ENABLE_EMOTES, true),
    builtin_emotes_enabled: parseBool(env.USE_BUILTIN_EMOTES, true),
    reactions_enabled: parseBool(env.ENABLE_REACTIONS, true),
    art_assets_enabled: parseBool(env.USE_ART_ASSETS, true),
  };
}
