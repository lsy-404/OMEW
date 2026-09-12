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

import type { InstanceConfig, RootRequirement, StrongholdCreationPolicy } from "./types";

export interface InstanceBranding {
  logo_url: string | null;
  emotes_enabled: boolean;
  reactions_enabled: boolean;
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

export function getInstanceConfig(env: Env): InstanceConfig {
  return {
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
  const logo = env.INSTANCE_LOGO_URL?.trim() ?? "";
  const logoUrl = logo.startsWith("/") || /^https:\/\//i.test(logo) ? logo : null;
  return {
    logo_url: logoUrl,
    emotes_enabled: parseBool(env.ENABLE_EMOTES, true),
    reactions_enabled: parseBool(env.ENABLE_REACTIONS, true),
  };
}
