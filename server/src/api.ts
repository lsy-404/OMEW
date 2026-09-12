import { createHash } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { base64UrlDecode, base64UrlEncode, dummyPasswordFields, hashPassword, newJti, signToken, verifyPassword, verifyToken } from "./auth";
import { getInstanceBranding, getInstanceConfig } from "./config";
import { handleInbox } from "./inbox";
import type { EffectivePermissions } from "./permissions";
import { canAccessRestrictedRoom, synthesizeEffectivePermissions } from "./permissions";
import { deriveSlugBase, featurePaused, fetchServerGroupsForLocalpart, type ConfigRow, type FeatureRestrictionSnapshot, type MemberRow, type RestrictedFeature, type RoomRow, type ServerFeatureOverride } from "./stronghold-do";
import { generateTotpSecret, totpOtpauthUrl, verifyTotpCode } from "./totp";
import {
  HOME_DOMAIN,
  instanceDomain,
  typeToKind,
  withRequestInstanceDomain,
  type Role,
  type RoomTokenClaims,
  type RoomType,
  type ServerRole,
  type FixedStronghold,
  type SessionTokenClaims,
  type StrongholdTokenClaims,
  type TotpPendingTokenClaims,
  type WebauthnAuthChallengeClaims,
  type WebauthnRegChallengeClaims,
} from "./types";
import { isReservedUsername } from "./reserved-usernames";
import {
  domainOfActor,
  generateInviteCode,
  isOriginTrusted,
  isValidEmail,
  isValidUsername,
  localpartOfActor,
  normalizeUsername,
  toPublicUser,
} from "./users";

export { RoomDO } from "./room-do";
export { StrongholdDO } from "./stronghold-do";

const SESSION_TOKEN_TTL_S = 24 * 60 * 60; // m0-protocol S7.2: session token lifetime MUST <= 24h.
const LAST_ACTIVE_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const ROOM_TOKEN_TTL_S = 300; // m0-protocol S7.3: room/stronghold WS token exp MUST <= 300s.
const MAX_BODY_BYTES = 64 * 1024;
const USERS_PAGE_SIZE = 50;
const MAX_OWNERSHIP_CIPHERTEXT_BYTES = 8 * 1024; // m0-protocol §7.9a: custody ciphertext size cap
const TOTP_PENDING_TTL_S = 300; // m0-protocol §7.2a
const WEBAUTHN_CHALLENGE_TTL_S = 300;
const TOTP_MAX_ATTEMPTS = 8; // per-account, independent of how many pending tokens get minted
const TOTP_LOCKOUT_S = 15 * 60;
const ADMIN_CONFIG_ARRAY_MAX = 100;
const ADMIN_CONFIG_DOMAIN_MAX = 253;
const ADMIN_CONFIG_ACTOR_LOCALPART_MAX = 64;
const ADMIN_CONFIG_ALLOWED_FIELDS = new Set([
  "ALLOW_ROOT",
  "ROOT_REQUIREMENTS",
  "TRUSTED_IDENTITY_SERVERS",
  "FEDERATION_PEERS",
  "STRONGHOLD_CREATION",
  "STRONGHOLD_CREATORS",
  "ALLOW_GUEST_BROWSING",
  "MAX_FILE_BYTES",
  "USER_STORAGE_QUOTA_BYTES",
] as const);
const STAR_DUST_SSO_ISSUER = "stardustinfinity.top";
const STAR_DUST_SSO_AUDIENCE = "omew.stardustinfinity.top";
const FIXED_STRONGHOLD_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export type AdminConfigEnvField =
  | "ALLOW_ROOT"
  | "ROOT_REQUIREMENTS"
  | "TRUSTED_IDENTITY_SERVERS"
  | "FEDERATION_PEERS"
  | "STRONGHOLD_CREATION"
  | "STRONGHOLD_CREATORS"
  | "ALLOW_GUEST_BROWSING"
  | "MAX_FILE_BYTES"
  | "USER_STORAGE_QUOTA_BYTES";
const ADMIN_CONFIG_ALIASES: Record<string, AdminConfigEnvField> = {
  allow_root: "ALLOW_ROOT",
  root_requirements: "ROOT_REQUIREMENTS",
  trusted_identity_servers: "TRUSTED_IDENTITY_SERVERS",
  federation_peers: "FEDERATION_PEERS",
  stronghold_creation_policy: "STRONGHOLD_CREATION",
  stronghold_creators: "STRONGHOLD_CREATORS",
  allow_guest_browsing: "ALLOW_GUEST_BROWSING",
  max_file_bytes: "MAX_FILE_BYTES",
  user_storage_quota_bytes: "USER_STORAGE_QUOTA_BYTES",
};

const ADMIN_CONFIG_FIELDS: Record<AdminConfigEnvField, keyof ReturnType<typeof getInstanceConfig>> = {
  ALLOW_ROOT: "allow_root",
  ROOT_REQUIREMENTS: "root_requirements",
  TRUSTED_IDENTITY_SERVERS: "trusted_identity_servers",
  FEDERATION_PEERS: "federation_peers",
  STRONGHOLD_CREATION: "stronghold_creation_policy",
  STRONGHOLD_CREATORS: "stronghold_creators",
  ALLOW_GUEST_BROWSING: "allow_guest_browsing",
  MAX_FILE_BYTES: "max_file_bytes",
  USER_STORAGE_QUOTA_BYTES: "user_storage_quota_bytes",
};

function isConfigDomain(value: unknown, options: { wildcard?: boolean; requireDot?: boolean } = {}): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ADMIN_CONFIG_DOMAIN_MAX) return false;
  if (value === "*") return options.wildcard === true;
  if (value !== value.toLowerCase() || (options.requireDot && !value.includes("."))) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isConfigActor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^@([a-z0-9._=-]{1,64}):(.+)$/.exec(value);
  return !!match && match[1]!.length <= ADMIN_CONFIG_ACTOR_LOCALPART_MAX && isConfigDomain(match[2]);
}

export function validateAdminConfigPatch(body: Record<string, unknown>, current: ReturnType<typeof getInstanceConfig>): Response | Partial<Record<AdminConfigEnvField, unknown>> {
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return apiError(400, "CONFIG_INVALID");
  }
  const patch: Partial<Record<AdminConfigEnvField, unknown>> = {};
  for (const inputKey of keys) {
    const key = (ADMIN_CONFIG_ALLOWED_FIELDS.has(inputKey as AdminConfigEnvField) ? inputKey : ADMIN_CONFIG_ALIASES[inputKey]) as AdminConfigEnvField | undefined;
    if (!key || key in patch) return apiError(400, "CONFIG_INVALID");
    const value = body[inputKey];
    if (key === "ALLOW_ROOT" || key === "ALLOW_GUEST_BROWSING") {
      if (typeof value !== "boolean") return apiError(400, "CONFIG_INVALID");
    } else if (key === "MAX_FILE_BYTES" || key === "USER_STORAGE_QUOTA_BYTES") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return apiError(400, "CONFIG_INVALID");
    } else if (key === "STRONGHOLD_CREATION") {
      if (value !== "open" && value !== "restricted" && value !== "application") return apiError(400, "CONFIG_INVALID");
    } else if (key === "ROOT_REQUIREMENTS") {
      if (!Array.isArray(value) || value.length > 3 || new Set(value).size !== value.length || value.some((entry) => entry !== "email" && entry !== "phone" && entry !== "code")) {
        return apiError(400, "CONFIG_INVALID");
      }
    } else if (key === "TRUSTED_IDENTITY_SERVERS" || key === "FEDERATION_PEERS") {
      const domainOptions = key === "TRUSTED_IDENTITY_SERVERS"
        ? { wildcard: true, requireDot: true }
        : { requireDot: true };
      if (!Array.isArray(value) || value.length > ADMIN_CONFIG_ARRAY_MAX || new Set(value).size !== value.length || value.some((entry) => !isConfigDomain(entry, domainOptions))) {
        return apiError(400, "CONFIG_INVALID");
      }
    } else if (key === "STRONGHOLD_CREATORS") {
      if (!Array.isArray(value) || value.length > ADMIN_CONFIG_ARRAY_MAX || value.some((entry) => !isConfigActor(entry))) {
        return apiError(400, "CONFIG_INVALID");
      }
    }
    patch[key] = value;
  }
  const maxFile = (patch.MAX_FILE_BYTES ?? current.max_file_bytes) as number;
  const quota = (patch.USER_STORAGE_QUOTA_BYTES ?? current.user_storage_quota_bytes) as number;
  if (quota < maxFile) return apiError(400, "CONFIG_INVALID");
  return patch;
}

function configValueToEnvText(field: AdminConfigEnvField, value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

export function buildAdminConfigBindings(
  existingBindings: Array<{ name: string }>,
  patch: Partial<Record<AdminConfigEnvField, unknown>>
): Array<Record<string, string>> {
  const bindings: Array<Record<string, string>> = [];
  const updated = new Set<AdminConfigEnvField>();
  for (const binding of existingBindings) {
    const name = binding.name;
    const field = ADMIN_CONFIG_ALLOWED_FIELDS.has(name as AdminConfigEnvField) ? name as AdminConfigEnvField : null;
    if (field && field in patch) {
      bindings.push({ name, type: "plain_text", text: configValueToEnvText(field, patch[field]) });
      updated.add(field);
    } else {
      bindings.push({ name, type: "inherit", version_id: "latest" });
    }
  }
  for (const field of Object.keys(patch) as AdminConfigEnvField[]) {
    if (!updated.has(field)) bindings.push({ name: field, type: "plain_text", text: configValueToEnvText(field, patch[field]) });
  }
  return bindings;
}

type AdminConfigFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function updateWorkerInstanceConfig(
  env: Env,
  patch: Partial<Record<AdminConfigEnvField, unknown>>,
  fetcher: AdminConfigFetch = fetch
): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_WORKER_NAME) return apiError(503, "CONFIG_UPSTREAM_UNAVAILABLE");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(env.CF_WORKER_NAME)}/settings`;
  let settingsResponse: Response;
  try {
    settingsResponse = await fetcher(endpoint, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return apiError(502, "CONFIG_UPSTREAM_UNAVAILABLE");
  }
  if (!settingsResponse.ok) return apiError(502, "CONFIG_UPSTREAM_ERROR");
  let existingBindings: Array<{ name: string }>;
  try {
    const payload = (await settingsResponse.json()) as { success?: unknown; result?: { bindings?: unknown } };
    const bindings = payload.result?.bindings;
    if (payload.success !== true || !Array.isArray(bindings) || bindings.some((binding) => typeof binding !== "object" || binding === null || typeof (binding as { name?: unknown }).name !== "string")) {
      return apiError(502, "CONFIG_UPSTREAM_ERROR");
    }
    existingBindings = bindings as Array<{ name: string }>;
  } catch {
    return apiError(502, "CONFIG_UPSTREAM_ERROR");
  }

  const bindings = buildAdminConfigBindings(existingBindings, patch);
  const form = new FormData();
  form.append("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }), "settings.json");
  let updateResponse: Response;
  try {
    updateResponse = await fetcher(endpoint, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return apiError(502, "CONFIG_UPSTREAM_UNAVAILABLE");
  }
  if (!updateResponse.ok) return apiError(502, "CONFIG_UPSTREAM_ERROR");
  try {
    const payload = (await updateResponse.json()) as { success?: unknown };
    if (payload.success !== true) return apiError(502, "CONFIG_UPSTREAM_ERROR");
  } catch {
    return apiError(502, "CONFIG_UPSTREAM_ERROR");
  }
  return json({ ...getInstanceConfig(env), ...Object.fromEntries(Object.entries(patch).map(([field, value]) => [ADMIN_CONFIG_FIELDS[field as AdminConfigEnvField], value])), source: "env-pending" });
}

// Claims a signed challenge/pending jti for one-time use. Expired rows are
// reaped opportunistically before each insert so the replay table stays bounded.
async function consumeChallengeOnce(env: Env, jti: string, exp: number): Promise<boolean> {
  try {
    await env.DB.prepare("DELETE FROM used_challenges WHERE exp <= ?").bind(nowS()).run();
    await env.DB.prepare("INSERT INTO used_challenges (jti, exp) VALUES (?, ?)").bind(jti, exp).run();
    return true;
  } catch {
    return false;
  }
}

// Per-account TOTP guess throttle: a fixed number of wrong codes locks further
// attempts out for TOTP_LOCKOUT_S, regardless of how many fresh pending/session
// tokens the caller can obtain in the meantime.
async function totpRateLimited(env: Env, localpart: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT locked_until FROM totp_attempts WHERE localpart = ?")
    .bind(localpart)
    .first<{ locked_until: number }>();
  return !!row && row.locked_until > nowS();
}

async function recordTotpFailure(env: Env, localpart: string): Promise<void> {
  const now = nowS();
  await env.DB.prepare(
    "INSERT INTO totp_attempts (localpart, fail_count, locked_until) VALUES (?1, 1, 0) " +
      "ON CONFLICT(localpart) DO UPDATE SET " +
      "fail_count = CASE WHEN totp_attempts.locked_until BETWEEN 1 AND ?2 THEN 1 ELSE totp_attempts.fail_count + 1 END, " +
      "locked_until = CASE " +
      "WHEN (CASE WHEN totp_attempts.locked_until BETWEEN 1 AND ?2 THEN 1 ELSE totp_attempts.fail_count + 1 END) >= ?3 THEN ?4 " +
      "WHEN totp_attempts.locked_until BETWEEN 1 AND ?2 THEN 0 " +
      "ELSE totp_attempts.locked_until END"
  )
    .bind(localpart, now, TOTP_MAX_ATTEMPTS, now + TOTP_LOCKOUT_S)
    .run();
}

async function recordTotpSuccess(env: Env, localpart: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO totp_attempts (localpart, fail_count, locked_until) VALUES (?, 0, 0) " +
      "ON CONFLICT(localpart) DO UPDATE SET fail_count = 0, locked_until = 0"
  )
    .bind(localpart)
    .run();
}

// m0-protocol §7.2a: WebAuthn RP ID / origin pair. Production targets the
// instance's own https domain; local/dev (INSTANCE_DOMAIN unset, falls back
// to HOME_DOMAIN "local") targets the workerd dev server directly, matching
// how the browser actually reaches it in both cases.
function webauthnRpId(env: Env): string {
  const domain = instanceDomain(env);
  return domain === HOME_DOMAIN ? "localhost" : domain;
}
function webauthnOrigin(env: Env): string {
  const domain = instanceDomain(env);
  return domain === HOME_DOMAIN ? "http://localhost:8787" : `https://${domain}`;
}

const RES_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function cors(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

// The /api/* and /federation/session contract is fixed (web is built against it in
// parallel) as a flat `{error: "CODE"}` - deliberately not the nested
// `{error:{code,message}}` shape used by the older routes above.
function apiError(status: number, code: string): Response {
  return json({ error: code }, status);
}

function getFixedStronghold(env: Env): FixedStronghold | null {
  const value = env.FIXED_STRONGHOLD?.trim();
  if (!value) return null;
  if (!FIXED_STRONGHOLD_RE.test(value)) throw new Error("invalid FIXED_STRONGHOLD");
  return { id: value, name: value, slug: value };
}

async function ensureFixedStronghold(env: Env): Promise<FixedStronghold | null> {
  const fixed = getFixedStronghold(env);
  if (!fixed) return null;
  const ownerActor = `@system:${instanceDomain(env)}`;
  const config = await env.STRONGHOLD_DO.getByName(fixed.id).ensureConfigWithDefaults(
    fixed.id,
    fixed.name,
    "public",
    ownerActor,
    "星尘站专属据点",
    fixed.slug,
  );
  return { id: config.id, name: config.name, slug: config.slug };
}

function strongholdPathId(path: string): string | null {
  if (path.startsWith("/api/stronghold/")) return path.split("/")[3] ?? null;
  if (path.startsWith("/stronghold/")) return path.split("/")[2] ?? null;
  return null;
}

type StarDustSsoClaims = {
  typ: "star_dust_sso";
  iss: typeof STAR_DUST_SSO_ISSUER;
  aud: typeof STAR_DUST_SSO_AUDIENCE;
  sub: string;
  username: string;
  email: string | null;
  exp: number;
};

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const len = request.headers.get("Content-Length");
  if (len && Number(len) > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function readBanExpiry(body: Record<string, unknown>): number | null | "invalid" {
  if (!("expires_at" in body) || body.expires_at === null) return null;
  return typeof body.expires_at === "number" && Number.isSafeInteger(body.expires_at) && body.expires_at > Date.now()
    ? body.expires_at
    : "invalid";
}

function readRestrictionExpiry(body: Record<string, unknown>): number | null | "invalid" {
  if (!("expires_at" in body) || body.expires_at === null) return null;
  return typeof body.expires_at === "number" && Number.isSafeInteger(body.expires_at) && body.expires_at > Date.now()
    ? body.expires_at
    : "invalid";
}

function readRestrictedFeature(value: unknown): RestrictedFeature | null {
  return value === "chat" || value === "posts" ? value : null;
}

function featureRestrictionsResponse(snapshot: FeatureRestrictionSnapshot) {
  const now = Date.now();
  const entry = (feature: RestrictedFeature) => {
    const rule = snapshot[feature];
    const serverActive = rule.server_override !== "inherit" && (rule.server_expires_at === null || rule.server_expires_at > now);
    const ownerActive = rule.owner_paused && (rule.owner_expires_at === null || rule.owner_expires_at > now);
    const source = serverActive ? "server" : ownerActive ? "owner" : "none";
    return {
      owner: { paused: rule.owner_paused, expires_at: rule.owner_expires_at },
      server: { mode: rule.server_override, expires_at: rule.server_expires_at },
      effective: {
        paused: featurePaused(rule, now),
        source,
        expires_at: serverActive ? rule.server_expires_at : ownerActive ? rule.owner_expires_at : null,
      },
    };
  };
  return { chat: entry("chat"), posts: entry("posts") };
}

// Timed bans are restored at the authorization boundary instead of depending on
// an alarm to run at an exact instant. This makes expiry reliable after Worker
// restarts and keeps every login/session path consistent.
async function clearExpiredGlobalBan(env: Env, localpart: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET status = 'active', banned_at = NULL, banned_by = NULL, banned_until = NULL " +
      "WHERE localpart = ? AND status = 'banned' AND banned_until IS NOT NULL AND banned_until <= ?"
  )
    .bind(localpart, Date.now())
    .run();
}

// Full session claims. Local server roles are mutable authorization state, so
// they are re-resolved from D1 instead of trusting the token's issuance-time
// snapshot. Remote actors can never receive a local server-role overlay.
async function requireSession(request: Request, env: Env): Promise<SessionTokenClaims | Response> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return apiError(401, "AUTH_REQUIRED");
  const claims = await verifyToken<SessionTokenClaims>(header.slice(7), env.DEV_TOKEN_SECRET);
  if (!claims || claims.typ !== "session") return apiError(401, "AUTH_REQUIRED");
  if (domainOfActor(claims.actor) !== instanceDomain(env)) {
    return { ...claims, server_role: "user" };
  }
  const localpart = localpartOfActor(claims.actor);
  await clearExpiredGlobalBan(env, localpart);
  const current = await env.DB.prepare("SELECT server_role, status, last_active_at FROM users WHERE localpart = ?")
    .bind(localpart)
    .first<{ server_role: ServerRole; status: string; last_active_at: number | null }>();
  if (!current || current.status !== "active") return apiError(401, "AUTH_REQUIRED");
  await touchLastActive(env, localpart, current.last_active_at);
  return { ...claims, server_role: current.server_role };
}

async function exchangeStarDustSession(body: Record<string, unknown>, env: Env): Promise<Response> {
  if (!env.STAR_DUST_SSO_SECRET) return apiError(503, "SSO_NOT_CONFIGURED");
  const rawToken = typeof body.token === "string" ? body.token : "";
  const claims = await verifyToken<StarDustSsoClaims>(rawToken, env.STAR_DUST_SSO_SECRET);
  if (
    !claims ||
    claims.typ !== "star_dust_sso" ||
    claims.iss !== STAR_DUST_SSO_ISSUER ||
    claims.aud !== STAR_DUST_SSO_AUDIENCE ||
    !/^[A-Za-z0-9_-]{1,48}$/.test(claims.sub) ||
    typeof claims.username !== "string" ||
    !claims.username.trim()
  ) {
    return apiError(401, "SSO_INVALID");
  }

  const localpart = `star-${claims.sub}`;
  const displayName = claims.username.trim().slice(0, 64);
  const email = typeof claims.email === "string" && isValidEmail(claims.email.trim()) ? claims.email.trim() : null;
  const now = nowS();

  await env.DB.prepare(
    "INSERT INTO users (localpart, display_name, status, created_at, email, email_verified) VALUES (?, ?, 'active', ?, ?, 0) " +
      "ON CONFLICT(localpart) DO UPDATE SET display_name = excluded.display_name, email = excluded.email"
  )
    .bind(localpart, displayName, now, email)
    .run();

  const user = await env.DB.prepare(
    "SELECT localpart, display_name, avatar, cover, bio, status, server_role, email, email_verified, totp_enabled " +
      "FROM users WHERE localpart = ?"
  )
    .bind(localpart)
    .first<{
      localpart: string;
      display_name: string;
      avatar: string | null;
      cover: string | null;
      bio: string | null;
      status: string;
      server_role: ServerRole;
      email: string | null;
      email_verified: number;
      totp_enabled: number;
    }>();
  if (!user || user.status !== "active") return apiError(403, "ACCOUNT_DISABLED");

  const actor = `@${localpart}:${instanceDomain(env)}`;
  const token = await issueSessionToken(actor, user.server_role, env);
  await touchLastActive(env, localpart);
  return json({ token, user: toPublicUser(user, actor) });
}

async function touchLastActive(env: Env, localpart: string, previous: number | null = null, now = Date.now()): Promise<void> {
  if (previous !== null && now - previous < LAST_ACTIVE_TOUCH_INTERVAL_MS) return;
  await env.DB.prepare(
    "UPDATE users SET last_active_at = ? WHERE localpart = ? AND (last_active_at IS NULL OR last_active_at < ?)"
  ).bind(now, localpart, now - LAST_ACTIVE_TOUCH_INTERVAL_MS).run();
}

// Thin actor-only wrapper over requireSession for the many routes that don't
// need server_role.
async function requireActor(request: Request, env: Env): Promise<string | null> {
  const session = await requireSession(request, env);
  return session instanceof Response ? null : session.actor;
}

// Server-level admin gate (m0-protocol §7.10): server_owner or server_admin.
// Replaces the old is_admin-column requireAdmin - "admin" here means "at least
// server_admin", owner always passes too.
async function requireServerRole(
  request: Request,
  env: Env,
  min: "admin" | "owner"
): Promise<{ actor: string; serverRole: ServerRole } | Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const ok = min === "owner" ? session.server_role === "owner" : session.server_role === "owner" || session.server_role === "admin";
  if (!ok) return apiError(403, "ADMIN_REQUIRED");
  return { actor: session.actor, serverRole: session.server_role };
}

// m0-protocol §7.10: server_owner/server_admin get owner-equivalent permissions
// in every stronghold, independent of actual membership - except ownership
// transfer, which stays gated on real ownership or server_owner specifically
// (handled at the transfer endpoint, not here). null means no access at all:
// no real membership (and no overlay), or banned with no overlay.
function overlayRole(serverRole: ServerRole, member: MemberRow | null): Role | null {
  if (serverRole === "owner" || serverRole === "admin") return "owner";
  if (!member || member.banned_at) return null;
  return member.role;
}

// m0-protocol §7.10a: overlayRole's group-aware counterpart - the
// one function every tier-gated route and the WS room-token mint call to get
// a member's actual effective role/deny once their server groups are folded
// in. Short-circuits the DO call entirely for the server_role owner/admin
// overlay, same as overlayRole did. Server groups are server-wide (not
// per-stronghold), so this composes the DO's baseline member row with a D1
// group read here, rather than delegating the whole thing to the DO.
async function effectiveRole(
  env: Env,
  strongholdId: string,
  serverRole: ServerRole,
  actor: string
): Promise<EffectivePermissions | null> {
  if (serverRole === "owner" || serverRole === "admin") return { role: "owner", deny: 0 };
  const stub = env.STRONGHOLD_DO.getByName(strongholdId);
  const member = await stub.getMember(actor);
  if (!member || member.banned_at) return null;
  if (member.role !== "member") return { role: member.role, deny: 0 };
  // Guests (federated actors) have no users row and thus no server groups.
  if (domainOfActor(actor) !== instanceDomain(env)) {
    return synthesizeEffectivePermissions("member", member.deny, []);
  }
  const groups = await fetchServerGroupsForLocalpart(env, localpartOfActor(actor));
  return synthesizeEffectivePermissions("member", member.deny, groups);
}

function isActorIdentifier(actor: string): boolean {
  return actor.startsWith("@") && actor.includes(":");
}

// Direct messages are available only inside the shared member surface that
// exposed the target. This keeps an authenticated account from probing or
// messaging arbitrary actors, while keeping the ordinary server-role overlay
// consistent with other stronghold member routes.
async function requireDirectMessageMembership(
  env: Env,
  strongholdId: string,
  session: SessionTokenClaims,
  targetActor: string
): Promise<Response | null> {
  const stub = env.STRONGHOLD_DO.getByName(strongholdId);
  const [requester, target] = await Promise.all([stub.getMember(session.actor), stub.getMember(targetActor)]);
  if (!overlayRole(session.server_role, requester)) return apiError(403, "FORBIDDEN");
  if (!target || target.banned_at) return apiError(404, "NOT_FOUND");
  return null;
}

// m0-protocol §7.10a revocation propagation: a server group
// definition or assignment change re-derives every affected local user's
// effective role/deny in every stronghold they belong to. Fan-out is
// fire-and-forget - a failed push to one stronghold never blocks the others
// or the caller's own mutation.
async function broadcastGroupRevoke(env: Env, localparts: string[]): Promise<void> {
  const unique = [...new Set(localparts)];
  if (unique.length === 0) return;
  const home = instanceDomain(env);
  await Promise.all(
    unique.map(async (localpart) => {
      const actor = `@${localpart}:${home}`;
      try {
        const { results } = await env.DB.prepare("SELECT stronghold_id FROM stronghold_member_index WHERE actor = ?")
          .bind(actor)
          .all<{ stronghold_id: string }>();
        await Promise.all(
          results.map((row) => {
            const stub = env.STRONGHOLD_DO.getByName(row.stronghold_id);
            return stub.revokeActor(actor).catch(() => {});
          })
        );
      } catch {
        // D1 lookup failure never blocks the caller's own mutation, which has
        // already committed - see the fire-and-forget note above.
      }
    })
  );
}

function match(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!;
    const v = pathParts[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (url.pathname === "/inbox" || url.pathname.startsWith("/inbox/")) {
      return handleInbox(request, env);
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", message: "unhandled api error", error: String(err) }));
      return errorResponse(500, "OMEW_INTERNAL", "internal error");
    }
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  env = withRequestInstanceDomain(env, url.hostname);
  const path = url.pathname;
  const method = request.method;
  const fixedStronghold = await ensureFixedStronghold(env);
  const requestedStrongholdId = strongholdPathId(path);
  if (fixedStronghold && requestedStrongholdId && requestedStrongholdId !== fixedStronghold.id) {
    return apiError(404, "NOT_FOUND");
  }

  // ---- instance identity policy + registration/login (real user system) ---------

  if (method === "GET" && path === "/api/instance/config") {
    const config = await getInstanceConfig(env);
    return json({
      allow_root: config.allow_root,
      root_requirements: config.root_requirements,
      // Policy value only (open/restricted/application) - enough for the client
      // to shape its "create stronghold" entry point; creators/peers stay admin-only.
      stronghold_creation: config.stronghold_creation_policy,
      allow_guest_browsing: config.allow_guest_browsing,
      fixed_stronghold: fixedStronghold,
      ...getInstanceBranding(env),
    });
  }

  if (method === "POST" && path === "/api/integration/star-dust/session") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    return exchangeStarDustSession(body, env);
  }

  const branding = getInstanceBranding(env);
  if (!branding.emotes_enabled && (path === "/api/emotes" || path.startsWith("/api/admin/emote-packs") || path.startsWith("/api/admin/emotes/"))) {
    return apiError(404, "FEATURE_DISABLED");
  }

  // Unauthenticated public-stronghold discovery. When the policy is
  // off the endpoint itself acts not-found rather than an empty list, matching
  // "you need to be logged in" 401s used elsewhere for a disabled read path -
  // there is no logged-in variant of this endpoint to fall back to either way.
  if (method === "GET" && path === "/api/directory") {
    const config = await getInstanceConfig(env);
    if (!config.allow_guest_browsing) return apiError(404, "NOT_FOUND");
    return json({ strongholds: await listPublicDirectory(env, fixedStronghold?.id) });
  }

  // URL short-name resolution, e.g. /a/<slug> - "a" is this instance's
  // own reserved server-id segment; every other value is a federated instance,
  // not yet implemented (M6-era), so it 404s rather than guessing. No auth -
  // a guest following a public stronghold's address needs this to work too.
  const resolveMatch = match("/api/resolve/:server/:slug", path);
  if (resolveMatch && method === "GET") {
    if (resolveMatch.server !== "a") return apiError(404, "NOT_FOUND");
    if (fixedStronghold && resolveMatch.slug !== fixedStronghold.slug) return apiError(404, "NOT_FOUND");
    const row = await env.DB.prepare("SELECT stronghold_id FROM stronghold_slug_index WHERE slug = ?")
      .bind(resolveMatch.slug!)
      .first<{ stronghold_id: string }>();
    if (!row) return apiError(404, "NOT_FOUND");
    return json({ stronghold_id: row.stronghold_id });
  }

  if (method === "POST" && path === "/api/register") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const config = await getInstanceConfig(env);
    if (!config.allow_root) return apiError(403, "REGISTRATION_DISABLED");

    const username = normalizeUsername(String(body.username ?? ""));
    if (!isValidUsername(username)) return apiError(400, "USERNAME_INVALID");
    // Only new registrations are filtered - accounts predating the blocklist keep their name.
    if (isReservedUsername(username)) return apiError(400, "USERNAME_RESERVED");

    const ownershipPubkey = typeof body.ownership_pubkey === "string" ? body.ownership_pubkey : "";
    const ownershipCiphertext = typeof body.ownership_ciphertext === "string" ? body.ownership_ciphertext : "";
    if (!ownershipPubkey || !ownershipCiphertext) return apiError(400, "OWNERSHIP_KEY_REQUIRED");

    const password = String(body.password ?? "");
    if (password.length < 8) return apiError(400, "PASSWORD_INVALID");

    const existing = await env.DB.prepare("SELECT localpart FROM users WHERE localpart = ?").bind(username).first();
    if (existing) return apiError(409, "USERNAME_TAKEN");

    const requiresCode = config.root_requirements.includes("code");
    const requiresEmail = config.root_requirements.includes("email");
    const requiresPhone = config.root_requirements.includes("phone");

    const code = String(body.code ?? "");
    if (requiresCode) {
      if (!code) return apiError(400, "INVITE_INVALID");
      const invite = await env.DB.prepare("SELECT code FROM invite_codes WHERE code = ? AND used_by IS NULL")
        .bind(code)
        .first();
      if (!invite) return apiError(400, "INVITE_INVALID");
    }

    const emailInput = typeof body.email === "string" ? body.email.trim() : "";
    if (requiresEmail && !emailInput) return apiError(400, "EMAIL_INVALID");
    if (emailInput && !isValidEmail(emailInput)) return apiError(400, "EMAIL_INVALID");
    const email = emailInput || null;

    // v1 has no SMS channel; "phone" stays a valid root_requirements enum member
    // (reserved for a future release) but can never be satisfied today.
    if (requiresPhone) return apiError(400, "PHONE_UNSUPPORTED");

    // TODO: once an Email Service binding is configured, send a verification email
    // here and leave email_verified=0 until it's confirmed. Until then registration
    // is never blocked on verification.

    const { hash, salt } = await hashPassword(password);
    const actor = `@${username}:${instanceDomain(env)}`;
    const now = Date.now();

    const statements = [
      env.DB.prepare(
        "INSERT INTO users (localpart, display_name, status, created_at, pw_hash, pw_salt, email, email_verified, ownership_pubkey, ownership_ciphertext) VALUES (?, ?, 'active', ?, ?, ?, ?, 0, ?, ?)"
      ).bind(username, username, now, hash, salt, email, ownershipPubkey, ownershipCiphertext),
    ];
    const codeConsumeIndex = requiresCode ? statements.length : -1;
    if (requiresCode) {
      statements.push(
        env.DB.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
          .bind(username, now, code)
      );
    }
    // m0-protocol §7.10: server_owner is unique, defaults to the first local
    // registration. Atomic first-mover claim: only the registration that
    // observes zero existing owners gets to set server_role='owner', so
    // concurrent first registrations can't both win.
    const ownerBootstrapIndex = statements.length;
    statements.push(
      env.DB.prepare(
        "UPDATE users SET server_role = 'owner' WHERE localpart = ? AND (SELECT COUNT(*) FROM users WHERE server_role = 'owner') = 0"
      ).bind(username)
    );

    let results: Awaited<ReturnType<typeof env.DB.batch>>;
    try {
      results = await env.DB.batch(statements);
    } catch {
      return apiError(409, "USERNAME_TAKEN");
    }

    if (requiresCode && results[codeConsumeIndex]!.meta.changes !== 1) {
      // Lost a race for the invite code between the pre-check and the batch commit;
      // undo the user we just created rather than admit them without a valid invite.
      await env.DB.prepare("DELETE FROM users WHERE localpart = ?").bind(username).run();
      return apiError(400, "INVITE_INVALID");
    }
    const serverRole: ServerRole = results[ownerBootstrapIndex]!.meta.changes === 1 ? "owner" : "user";

    let token: string;
    try {
      token = await issueSessionToken(actor, serverRole, env);
    } catch (err) {
      // Signing failed after the user row was committed - roll the registration
      // back (and release any consumed invite code) so a retry can succeed
      // instead of hitting USERNAME_TAKEN on a half-created account.
      await env.DB.prepare("DELETE FROM users WHERE localpart = ?").bind(username).run();
      if (requiresCode) {
        await env.DB.prepare("UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE used_by = ?").bind(username).run();
      }
      throw err;
    }
    const user = toPublicUser({ localpart: username, server_role: serverRole, email, email_verified: 0, avatar: null, cover: null, bio: null }, actor);
    return json({ token, user });
  }

  if (method === "POST" && path === "/api/login") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const username = normalizeUsername(String(body.username ?? ""));
    const password = String(body.password ?? "");
    await clearExpiredGlobalBan(env, username);

    const user = await env.DB.prepare(
      "SELECT localpart, display_name, avatar, cover, bio, pw_hash, pw_salt, status, server_role, email, email_verified, totp_enabled FROM users WHERE localpart = ?"
    )
      .bind(username)
      .first<{
        localpart: string;
        display_name: string;
        avatar: string | null;
        cover: string | null;
        bio: string | null;
        pw_hash: string | null;
        pw_salt: string | null;
        status: string;
        server_role: ServerRole;
        email: string | null;
        email_verified: number;
        totp_enabled: number;
      }>();

    // Always pay the same PBKDF2 cost whether or not the account exists, and never
    // distinguish "no such user" from "wrong password" in the response - both are
    // AUTH_FAILED, so login timing/response can't be used to enumerate usernames.
    const dummy = dummyPasswordFields();
    const valid = await verifyPassword(password, user?.pw_hash ?? dummy.hash, user?.pw_salt ?? dummy.salt);
    if (!user || !valid || user.status !== "active") {
      return apiError(401, "AUTH_FAILED");
    }

    const actor = `@${username}:${instanceDomain(env)}`;

    // m0-protocol §7.2a: TOTP second factor gates password login specifically.
    // No session is issued yet - the client must complete POST /api/login/totp
    // with a valid code before getting one.
    if (user.totp_enabled === 1) {
      const pending: TotpPendingTokenClaims = {
        v: 1, typ: "totp_pending", actor, exp: nowS() + TOTP_PENDING_TTL_S, jti: newJti(),
      };
      return json({ totp_required: true, pending: await signToken(pending, env.DEV_TOKEN_SECRET) });
    }

    const token = await issueSessionToken(actor, user.server_role, env);
    await touchLastActive(env, username);
    return json({ token, user: toPublicUser(user, actor) });
  }

  if (method === "POST" && path === "/api/login/totp") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const pendingToken = typeof body.pending === "string" ? body.pending : "";
    const code = typeof body.code === "string" ? body.code : "";
    if (!pendingToken || !code) return apiError(400, "PAYLOAD_INVALID");

    const claims = await verifyToken<TotpPendingTokenClaims>(pendingToken, env.DEV_TOKEN_SECRET);
    if (!claims || claims.typ !== "totp_pending") return apiError(401, "AUTH_FAILED");

    const localpart = localpartOfActor(claims.actor);
    if (await totpRateLimited(env, localpart)) return apiError(429, "TOTP_RATE_LIMITED");
    await clearExpiredGlobalBan(env, localpart);

    const user = await env.DB.prepare(
      "SELECT localpart, display_name, avatar, cover, bio, status, server_role, email, email_verified, totp_secret, totp_enabled FROM users WHERE localpart = ?"
    )
      .bind(localpart)
      .first<{
        localpart: string;
        display_name: string;
        avatar: string | null;
        cover: string | null;
        bio: string | null;
        status: string;
        server_role: ServerRole;
        email: string | null;
        email_verified: number;
        totp_secret: string | null;
        totp_enabled: number;
      }>();
    if (!user || user.status !== "active" || user.totp_enabled !== 1 || !user.totp_secret) {
      return apiError(401, "AUTH_FAILED");
    }

    const step = verifyTotpCode(user.totp_secret, code);
    if (step === null) {
      await recordTotpFailure(env, localpart);
      return apiError(401, "TOTP_INVALID");
    }

    // Atomic compare-and-set: a concurrent request that raced this one to the
    // same last_totp_step value loses here instead of both succeeding (TOCTOU).
    const consumed = await env.DB.prepare("UPDATE users SET last_totp_step = ? WHERE localpart = ? AND last_totp_step != ?")
      .bind(step, localpart, step)
      .run();
    if (consumed.meta.changes === 0) {
      await recordTotpFailure(env, localpart);
      return apiError(401, "TOTP_INVALID");
    }

    await recordTotpSuccess(env, localpart);
    const token = await issueSessionToken(claims.actor, user.server_role, env);
    await touchLastActive(env, localpart);
    return json({ token, user: toPublicUser(user, claims.actor) });
  }

  // ---- account: display name ---------------------------------------------------------
  // The localpart (and therefore the actor) is immutable - this only renames how
  // the account is shown in member lists, message bylines and profile cards.

  if (method === "POST" && path === "/api/me/display-name") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
    if (!displayName || displayName.length > 32) return apiError(400, "DISPLAY_NAME_INVALID");

    await env.DB.prepare("UPDATE users SET display_name = ? WHERE localpart = ?")
      .bind(displayName, localpartOfActor(actor))
      .run();
    return json({ display_name: displayName });
  }

  if (method === "POST" && path === "/api/me/bio") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body || typeof body.bio !== "string") return apiError(400, "BIO_INVALID");
    const bio = body.bio.trim();
    if ([...bio].length > 512) return apiError(400, "BIO_INVALID");
    await env.DB.prepare("UPDATE users SET bio = ? WHERE localpart = ?")
      .bind(bio || null, localpartOfActor(actor))
      .run();
    return json({ bio: bio || null });
  }

  if (path === "/api/me/avatar" && (method === "POST" || method === "DELETE")) {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    if (domainOfActor(actor) !== instanceDomain(env)) return apiError(403, "FORBIDDEN");
    const localpart = localpartOfActor(actor);

    if (method === "DELETE") {
      const previous = await env.DB.prepare("SELECT avatar FROM users WHERE localpart = ?").bind(localpart).first<{ avatar: string | null }>();
      const cleared = await env.DB.prepare("UPDATE users SET avatar = NULL WHERE localpart = ?").bind(localpart).run();
      if (cleared.meta.changes === 0) return apiError(404, "NOT_FOUND");
      await deleteOwnedMediaReference(env, actor, previous?.avatar);
      return json({ avatar: null });
    }

    const mime = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!SANITIZED_IMAGE_MIME_WHITELIST.has(mime)) {
      await request.body?.cancel().catch(() => {});
      return apiError(415, "AVATAR_IMAGE_REQUIRED");
    }

    const uploadedResponse = await handleMediaUpload(request, env);
    if (!uploadedResponse.ok) return uploadedResponse;
    const uploaded = await uploadedResponse.json() as { id: string; url: string; size: number; mime: string };
    const previous = await env.DB.prepare("SELECT avatar FROM users WHERE localpart = ?").bind(localpart).first<{ avatar: string | null }>();
    try {
      const updated = await env.DB.prepare("UPDATE users SET avatar = ? WHERE localpart = ?")
        .bind(uploaded.url, localpart)
        .run();
      if (updated.meta.changes === 0) throw new Error("USER_NOT_FOUND");
    } catch {
      await env.MEDIA.delete(`media/${uploaded.id}`).catch(() => {});
      await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(uploaded.id).run().catch(() => {});
      return apiError(500, "AVATAR_UPDATE_FAILED");
    }
    await deleteOwnedMediaReference(env, actor, previous?.avatar, uploaded.id);
    return json({ ...uploaded, avatar: uploaded.url }, 201);
  }

  if (path === "/api/me/cover" && (method === "POST" || method === "DELETE")) {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    if (domainOfActor(actor) !== instanceDomain(env)) return apiError(403, "FORBIDDEN");
    const localpart = localpartOfActor(actor);
    if (method === "DELETE") {
      const previous = await env.DB.prepare("SELECT cover FROM users WHERE localpart = ?").bind(localpart).first<{ cover: string | null }>();
      const cleared = await env.DB.prepare("UPDATE users SET cover = NULL WHERE localpart = ?").bind(localpart).run();
      if (cleared.meta.changes === 0) return apiError(404, "NOT_FOUND");
      await deleteOwnedMediaReference(env, actor, previous?.cover);
      return json({ cover: null });
    }
    const mime = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!SANITIZED_IMAGE_MIME_WHITELIST.has(mime)) {
      await request.body?.cancel().catch(() => {});
      return apiError(415, "COVER_IMAGE_REQUIRED");
    }
    const uploadedResponse = await handleMediaUpload(request, env);
    if (!uploadedResponse.ok) return uploadedResponse;
    const uploaded = await uploadedResponse.json() as { id: string; url: string; size: number; mime: string };
    const previous = await env.DB.prepare("SELECT cover FROM users WHERE localpart = ?").bind(localpart).first<{ cover: string | null }>();
    try {
      const updated = await env.DB.prepare("UPDATE users SET cover = ? WHERE localpart = ?").bind(uploaded.url, localpart).run();
      if (updated.meta.changes === 0) throw new Error("USER_NOT_FOUND");
    } catch {
      await env.MEDIA.delete(`media/${uploaded.id}`).catch(() => {});
      await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(uploaded.id).run().catch(() => {});
      return apiError(500, "COVER_UPDATE_FAILED");
    }
    await deleteOwnedMediaReference(env, actor, previous?.cover, uploaded.id);
    return json({ ...uploaded, cover: uploaded.url }, 201);
  }

  // ---- account: change password ----------------------------------------------------

  if (method === "POST" && path === "/api/me/password") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const oldPassword = String(body.old_password ?? "");
    const newPassword = String(body.new_password ?? "");
    // Same strength check as registration (users.ts has no separate policy for it).
    if (newPassword.length < 8) return apiError(400, "PASSWORD_INVALID");

    // Optional (m0-protocol §7.9a): when the custody passphrase defaults to the
    // login password, the client re-wraps the custody ciphertext under the new
    // password and submits it alongside the password change so both move
    // together atomically. Absent when the account uses an independent custody
    // passphrase (client couldn't unseal with the old login password, so it
    // leaves the ciphertext untouched).
    const newOwnershipCiphertext = typeof body.new_ownership_ciphertext === "string" ? body.new_ownership_ciphertext : undefined;
    if (newOwnershipCiphertext !== undefined) {
      const byteLength = new TextEncoder().encode(newOwnershipCiphertext).length;
      if (byteLength === 0 || byteLength > MAX_OWNERSHIP_CIPHERTEXT_BYTES) {
        return apiError(400, "OWNERSHIP_CIPHERTEXT_INVALID");
      }
    }

    const localpart = localpartOfActor(actor);
    const user = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ pw_hash: string | null; pw_salt: string | null }>();
    // Same constant-cost-regardless-of-outcome shape as /api/login.
    const dummy = dummyPasswordFields();
    const valid = await verifyPassword(oldPassword, user?.pw_hash ?? dummy.hash, user?.pw_salt ?? dummy.salt);
    if (!user || !valid) return apiError(401, "AUTH_FAILED");

    const { hash, salt } = await hashPassword(newPassword);
    if (newOwnershipCiphertext !== undefined) {
      await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, ownership_ciphertext = ? WHERE localpart = ?")
        .bind(hash, salt, newOwnershipCiphertext, localpart)
        .run();
    } else {
      await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE localpart = ?")
        .bind(hash, salt, localpart)
        .run();
    }
    // v1: no server-side session revocation list exists, so this user's other
    // outstanding session tokens stay valid until their own 24h TTL expiry rather
    // than being force-invalidated here.
    return new Response(null, { status: 204, headers: cors() });
  }

  // GET /api/me/ownership: lets the change-password flow fetch the caller's own
  // custody envelope client-side so it can attempt to unseal it with the old
  // password and re-wrap it with the new one (m0-protocol §7.9a).
  if (method === "GET" && path === "/api/me/ownership") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const localpart = localpartOfActor(actor);
    const user = await env.DB.prepare("SELECT ownership_pubkey, ownership_ciphertext FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ ownership_pubkey: string | null; ownership_ciphertext: string | null }>();
    if (!user) return apiError(404, "NOT_FOUND");
    return json({ ownership_pubkey: user.ownership_pubkey ?? "", ownership_ciphertext: user.ownership_ciphertext ?? "" });
  }

  // ---- account: TOTP second factor (m0-protocol §7.2a) ------------------------------

  if (method === "POST" && path === "/api/me/totp/setup") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const localpart = localpartOfActor(actor);
    const user = await env.DB.prepare("SELECT totp_enabled FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ totp_enabled: number }>();
    if (!user) return apiError(404, "NOT_FOUND");
    if (user.totp_enabled === 1) return apiError(409, "TOTP_ALREADY_ENABLED");

    const secret = generateTotpSecret();
    await env.DB.prepare("UPDATE users SET totp_secret = ? WHERE localpart = ?").bind(secret, localpart).run();
    return json({ secret, otpauth_url: totpOtpauthUrl(localpart, secret) });
  }

  if (method === "POST" && path === "/api/me/totp/activate") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const code = typeof body.code === "string" ? body.code : "";
    if (!code) return apiError(400, "PAYLOAD_INVALID");

    const localpart = localpartOfActor(actor);
    if (await totpRateLimited(env, localpart)) return apiError(429, "TOTP_RATE_LIMITED");

    const user = await env.DB.prepare("SELECT totp_secret FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ totp_secret: string | null }>();
    if (!user?.totp_secret) return apiError(409, "TOTP_NOT_PENDING");

    const step = verifyTotpCode(user.totp_secret, code);
    if (step === null) {
      await recordTotpFailure(env, localpart);
      return apiError(401, "TOTP_INVALID");
    }

    // Atomic compare-and-set closes the same TOCTOU as the login endpoint.
    const consumed = await env.DB.prepare(
      "UPDATE users SET totp_enabled = 1, last_totp_step = ? WHERE localpart = ? AND last_totp_step != ?"
    )
      .bind(step, localpart, step)
      .run();
    if (consumed.meta.changes === 0) {
      await recordTotpFailure(env, localpart);
      return apiError(409, "TOTP_CODE_REUSED");
    }

    await recordTotpSuccess(env, localpart);
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/me/totp/disable") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const password = typeof body.password === "string" ? body.password : "";
    const code = typeof body.code === "string" ? body.code : "";
    if (!password || !code) return apiError(400, "PAYLOAD_INVALID");

    const localpart = localpartOfActor(actor);
    if (await totpRateLimited(env, localpart)) return apiError(429, "TOTP_RATE_LIMITED");

    const user = await env.DB.prepare("SELECT pw_hash, pw_salt, totp_secret FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ pw_hash: string | null; pw_salt: string | null; totp_secret: string | null }>();
    const dummy = dummyPasswordFields();
    const validPassword = await verifyPassword(password, user?.pw_hash ?? dummy.hash, user?.pw_salt ?? dummy.salt);
    if (!user || !validPassword) return apiError(401, "AUTH_FAILED");
    if (!user.totp_secret) return apiError(409, "TOTP_NOT_PENDING");

    const step = verifyTotpCode(user.totp_secret, code);
    if (step === null) {
      await recordTotpFailure(env, localpart);
      return apiError(401, "TOTP_INVALID");
    }

    // Atomic compare-and-set closes the same TOCTOU as the login endpoint.
    const consumed = await env.DB.prepare(
      "UPDATE users SET totp_secret = NULL, totp_enabled = 0, last_totp_step = 0 WHERE localpart = ? AND last_totp_step != ?"
    )
      .bind(localpart, step)
      .run();
    if (consumed.meta.changes === 0) {
      await recordTotpFailure(env, localpart);
      return apiError(401, "TOTP_INVALID");
    }

    await recordTotpSuccess(env, localpart);
    return json({ ok: true });
  }

  // ---- account: WebAuthn passkeys (m0-protocol §7.2a) --------------------------------

  if (method === "GET" && path === "/api/me/passkeys") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const localpart = localpartOfActor(actor);
    const { results } = await env.DB.prepare(
      "SELECT credential_id, name, created_at FROM webauthn_credentials WHERE localpart = ? ORDER BY created_at ASC"
    )
      .bind(localpart)
      .all<{ credential_id: string; name: string; created_at: number }>();
    return json({ passkeys: results.map((r) => ({ id: r.credential_id, name: r.name, created_at: r.created_at })) });
  }

  if (method === "POST" && path === "/api/me/passkeys/options") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const localpart = localpartOfActor(actor);
    const { results: existing } = await env.DB.prepare("SELECT credential_id, transports FROM webauthn_credentials WHERE localpart = ?")
      .bind(localpart)
      .all<{ credential_id: string; transports: string | null }>();

    const options = await generateRegistrationOptions({
      rpName: "OMEW",
      rpID: webauthnRpId(env),
      userName: localpart,
      userID: new TextEncoder().encode(localpart) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required" },
      excludeCredentials: existing.map((r) => ({
        id: r.credential_id,
        transports: r.transports ? (JSON.parse(r.transports) as AuthenticatorTransportFuture[]) : undefined,
      })),
    });

    const challengeClaims: WebauthnRegChallengeClaims = {
      v: 1, typ: "webauthn_reg", actor, challenge: options.challenge, exp: nowS() + WEBAUTHN_CHALLENGE_TTL_S, jti: newJti(),
    };
    return json({ options, challenge_token: await signToken(challengeClaims, env.DEV_TOKEN_SECRET) });
  }

  if (method === "POST" && path === "/api/me/passkeys") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return apiError(400, "PAYLOAD_INVALID");
    const challengeToken = typeof body.challenge_token === "string" ? body.challenge_token : "";
    const response = body.response as RegistrationResponseJSON | undefined;
    if (!challengeToken || !response) return apiError(400, "PAYLOAD_INVALID");

    const claims = await verifyToken<WebauthnRegChallengeClaims>(challengeToken, env.DEV_TOKEN_SECRET);
    if (!claims || claims.typ !== "webauthn_reg" || claims.actor !== actor) return apiError(401, "AUTH_REQUIRED");
    if (!(await consumeChallengeOnce(env, claims.jti, claims.exp))) return apiError(401, "AUTH_REQUIRED");

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: claims.challenge,
        expectedOrigin: webauthnOrigin(env),
        expectedRPID: webauthnRpId(env),
      });
    } catch {
      return apiError(400, "PASSKEY_VERIFY_FAILED");
    }
    if (!verification.verified) return apiError(400, "PASSKEY_VERIFY_FAILED");

    const { id, publicKey, counter, transports } = verification.registrationInfo.credential;
    const localpart = localpartOfActor(actor);
    const now = Date.now();
    try {
      await env.DB.prepare(
        "INSERT INTO webauthn_credentials (credential_id, localpart, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, localpart, base64UrlEncode(publicKey), counter, transports ? JSON.stringify(transports) : null, name, now)
        .run();
    } catch {
      return apiError(409, "PASSKEY_ALREADY_REGISTERED");
    }
    return json({ id, name, created_at: now });
  }

  const passkeyMatch = match("/api/me/passkeys/:id", path);
  if (passkeyMatch && (method === "PATCH" || method === "DELETE")) {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const localpart = localpartOfActor(actor);
    const owned = await env.DB.prepare("SELECT credential_id FROM webauthn_credentials WHERE credential_id = ? AND localpart = ?")
      .bind(passkeyMatch.id!, localpart)
      .first<{ credential_id: string }>();
    if (!owned) return apiError(404, "NOT_FOUND");

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM webauthn_credentials WHERE credential_id = ?").bind(passkeyMatch.id!).run();
      return json({ ok: true });
    }

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return apiError(400, "PAYLOAD_INVALID");
    await env.DB.prepare("UPDATE webauthn_credentials SET name = ? WHERE credential_id = ?").bind(name, passkeyMatch.id!).run();
    const row = await env.DB.prepare("SELECT credential_id, name, created_at FROM webauthn_credentials WHERE credential_id = ?")
      .bind(passkeyMatch.id!)
      .first<{ credential_id: string; name: string; created_at: number }>();
    return json({ id: row!.credential_id, name: row!.name, created_at: row!.created_at });
  }

  // ---- passkey login (no session - this IS the login path) --------------------------

  if (method === "POST" && path === "/api/login/passkey/options") {
    const options = await generateAuthenticationOptions({ rpID: webauthnRpId(env), allowCredentials: [] });
    const challengeClaims: WebauthnAuthChallengeClaims = {
      v: 1, typ: "webauthn_auth", challenge: options.challenge, exp: nowS() + WEBAUTHN_CHALLENGE_TTL_S, jti: newJti(),
    };
    return json({ options, challenge_token: await signToken(challengeClaims, env.DEV_TOKEN_SECRET) });
  }

  if (method === "POST" && path === "/api/login/passkey") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const challengeToken = typeof body.challenge_token === "string" ? body.challenge_token : "";
    const response = body.response as AuthenticationResponseJSON | undefined;
    if (!challengeToken || !response) return apiError(400, "PAYLOAD_INVALID");

    const claims = await verifyToken<WebauthnAuthChallengeClaims>(challengeToken, env.DEV_TOKEN_SECRET);
    if (!claims || claims.typ !== "webauthn_auth") return apiError(401, "AUTH_FAILED");
    // Single-use: a captured (challenge_token, response) pair must not mint a
    // second session once the first attempt has consumed this challenge.
    if (!(await consumeChallengeOnce(env, claims.jti, claims.exp))) return apiError(401, "AUTH_FAILED");

    const credentialId = response.id;
    const row = await env.DB.prepare(
      "SELECT w.credential_id, w.public_key, w.counter, w.transports, w.localpart, u.display_name, u.avatar, u.cover, u.bio, u.status, u.server_role, u.email, u.email_verified, u.totp_enabled FROM webauthn_credentials w JOIN users u ON u.localpart = w.localpart WHERE w.credential_id = ?"
    )
      .bind(credentialId)
      .first<{
        credential_id: string;
        public_key: string;
        counter: number;
        transports: string | null;
        localpart: string;
        display_name: string;
        avatar: string | null;
        cover: string | null;
        bio: string | null;
        status: string;
        server_role: ServerRole;
        email: string | null;
        email_verified: number;
        totp_enabled: number;
      }>();
    if (!row) return apiError(401, "AUTH_FAILED");
    await clearExpiredGlobalBan(env, row.localpart);
    if (row.status === "banned") {
      const current = await env.DB.prepare("SELECT status FROM users WHERE localpart = ?").bind(row.localpart).first<{ status: string }>();
      if (current?.status === "active") row.status = "active";
    }
    if (row.status !== "active") return apiError(401, "AUTH_FAILED");

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: claims.challenge,
        expectedOrigin: webauthnOrigin(env),
        expectedRPID: webauthnRpId(env),
        credential: {
          id: row.credential_id,
          publicKey: base64UrlDecode(row.public_key) as Uint8Array<ArrayBuffer>,
          counter: row.counter,
          transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[]) : undefined,
        },
      });
    } catch {
      return apiError(401, "AUTH_FAILED");
    }
    // Counter regression (newCounter <= stored, when stored > 0) indicates a
    // cloned authenticator per the WebAuthn spec - reject and deliberately
    // leave the stored counter untouched so the credential stays flagged.
    if (!verification.verified || (row.counter > 0 && verification.authenticationInfo.newCounter <= row.counter)) {
      return apiError(401, "AUTH_FAILED");
    }

    await env.DB.prepare("UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?")
      .bind(verification.authenticationInfo.newCounter, row.credential_id)
      .run();

    const actor = `@${row.localpart}:${instanceDomain(env)}`;
    const token = await issueSessionToken(actor, row.server_role, env);
    await touchLastActive(env, row.localpart);
    return json({ token, user: toPublicUser(row, actor) });
  }

  // ---- instance admin --------------------------------------------------------------
  // Policy fields are deployment env config. GET reflects the currently loaded
  // env; owner PATCH updates the worker's deployment settings asynchronously.

  if (method === "GET" && path === "/api/admin/instance/config") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    return json({ ...getInstanceConfig(env), source: "env" });
  }

  if (method === "PATCH" && path === "/api/admin/instance/config") {
    const gate = await requireServerRole(request, env, "owner");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const patch = validateAdminConfigPatch(body, getInstanceConfig(env));
    if (patch instanceof Response) return patch;
    return updateWorkerInstanceConfig(env, patch);
  }

  if (method === "POST" && path === "/api/admin/invite-codes") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) return apiError(400, "COUNT_INVALID");

    const now = Date.now();
    const codes = Array.from({ length: count }, () => generateInviteCode());
    await env.DB.batch(
      codes.map((code) =>
        env.DB.prepare("INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)")
          .bind(code, gate.actor, now)
      )
    );
    return json(
      { codes: codes.map((code) => ({ code, created_by: gate.actor, created_at: now, used_by: null, used_at: null })) },
      201
    );
  }

  if (method === "GET" && path === "/api/admin/invite-codes") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const { results } = await env.DB.prepare(
      "SELECT code, created_by, created_at, used_by, used_at FROM invite_codes ORDER BY created_at DESC"
    ).all();
    return json({ codes: results });
  }

  // ---- server-level role appointment (m0-protocol §7.10) --------------------------
  // Listing accounts is available to server_admin so they can assign existing
  // server-level user groups. Changing server_role remains server_owner-only.

  if (method === "GET" && path === "/api/admin/users") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const after = url.searchParams.get("after");
    const { results } = await env.DB.prepare(
      "SELECT localpart, server_role, created_at FROM users WHERE localpart > ? ORDER BY localpart LIMIT ?"
    )
      .bind(after ?? "", USERS_PAGE_SIZE + 1)
      .all<{ localpart: string; server_role: ServerRole; created_at: number }>();
    const hasMore = results.length > USERS_PAGE_SIZE;
    const page = hasMore ? results.slice(0, USERS_PAGE_SIZE) : results;
    return json({ users: page, next_cursor: hasMore ? page[page.length - 1]!.localpart : null });
  }

  if (method === "GET" && path === "/api/admin/bans") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    await env.DB.prepare(
      "UPDATE users SET status = 'active', banned_at = NULL, banned_by = NULL, banned_until = NULL " +
        "WHERE status = 'banned' AND banned_until IS NOT NULL AND banned_until <= ?"
    ).bind(Date.now()).run();
    const { results } = await env.DB.prepare(
      "SELECT localpart, banned_by, banned_at, banned_until FROM users WHERE status = 'banned' ORDER BY banned_at DESC"
    ).all<{ localpart: string; banned_by: string; banned_at: number; banned_until: number | null }>();
    return json({ entries: results.map((entry) => ({ actor: `@${entry.localpart}:${instanceDomain(env)}`, operator: entry.banned_by, banned_at: entry.banned_at, expires_at: entry.banned_until })) });
  }

  const globalBanMatch = match("/api/admin/bans/:actor", path);
  if (globalBanMatch && (method === "PUT" || method === "DELETE")) {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const targetActor = globalBanMatch.actor!;
    if (domainOfActor(targetActor) !== instanceDomain(env) || !localpartOfActor(targetActor)) return apiError(404, "NOT_FOUND");
    const localpart = localpartOfActor(targetActor);
    const target = await env.DB.prepare("SELECT server_role FROM users WHERE localpart = ?")
      .bind(localpart)
      .first<{ server_role: ServerRole }>();
    if (!target) return apiError(404, "NOT_FOUND");
    // The instance owner cannot be locked out. Server admins may moderate only
    // ordinary accounts; the owner retains authority over admin accounts.
    if (target.server_role === "owner" || (gate.serverRole === "admin" && target.server_role !== "user")) return apiError(403, "FORBIDDEN");

    if (method === "DELETE") {
      await env.DB.prepare(
        "UPDATE users SET status = 'active', banned_at = NULL, banned_by = NULL, banned_until = NULL WHERE localpart = ? AND status = 'banned'"
      ).bind(localpart).run();
      return new Response(null, { status: 204, headers: cors() });
    }

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const expiresAt = readBanExpiry(body);
    if (expiresAt === "invalid") return apiError(400, "EXPIRY_INVALID");
    const bannedAt = Date.now();
    await env.DB.prepare(
      "UPDATE users SET status = 'banned', banned_at = ?, banned_by = ?, banned_until = ? WHERE localpart = ?"
    ).bind(bannedAt, gate.actor, expiresAt, localpart).run();
    // Server admins may be connected through the server-role overlay without a
    // membership-index row, so enumerate the global stronghold slug index.
    const { results } = await env.DB.prepare("SELECT DISTINCT stronghold_id FROM stronghold_slug_index")
      .all<{ stronghold_id: string }>();
    await Promise.all(results.map((row) => env.STRONGHOLD_DO.getByName(row.stronghold_id).revokeServerRole(targetActor).catch(() => {})));
    return json({ actor: targetActor, operator: gate.actor, banned_at: bannedAt, expires_at: expiresAt });
  }

  const userRoleMatch = match("/api/admin/users/:localpart", path);
  if (userRoleMatch && method === "PATCH") {
    const gate = await requireServerRole(request, env, "owner");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    if (body.server_role !== "admin" && body.server_role !== "user") return apiError(400, "ROLE_INVALID");
    // server_owner is unique and non-transferable through this endpoint - can't
    // touch its own row (the only row that could be "owner"), and can't create
    // a second one.
    if (userRoleMatch.localpart === localpartOfActor(gate.actor)) return apiError(400, "ROLE_INVALID");

    const previous = await env.DB.prepare("SELECT server_role FROM users WHERE localpart = ?")
      .bind(userRoleMatch.localpart!)
      .first<{ server_role: ServerRole }>();
    if (!previous || previous.server_role === "owner") return apiError(404, "NOT_FOUND");
    const result = await env.DB.prepare("UPDATE users SET server_role = ? WHERE localpart = ? AND server_role != 'owner'")
      .bind(body.server_role, userRoleMatch.localpart!)
      .run();
    if (result.meta.changes === 0) return apiError(404, "NOT_FOUND");
    if (previous.server_role === "admin" && body.server_role === "user") {
      const actor = `@${userRoleMatch.localpart}:${instanceDomain(env)}`;
      const { results } = await env.DB.prepare("SELECT DISTINCT stronghold_id FROM stronghold_member_index")
        .all<{ stronghold_id: string }>();
      await Promise.all(
        results.map((row) => env.STRONGHOLD_DO.getByName(row.stronghold_id).revokeServerRole(actor))
      );
    }
    return json({ localpart: userRoleMatch.localpart, server_role: body.server_role });
  }

  // ---- server-level user groups (m0-protocol §7.10a) --------------------
  // Server-wide (not per-stronghold) - only local users can be assigned. Any
  // definition or assignment change fans out a revocation to every stronghold
  // the affected user(s) belong to (see broadcastGroupRevoke below).

  if (method === "POST" && path === "/api/admin/server-groups") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isValidGroupName(name)) return apiError(400, "GROUP_NAME_INVALID");
    const color = parseOptionalColor(body.color);
    if (color === INVALID_COLOR) return apiError(400, "GROUP_COLOR_INVALID");
    const allowSpeak = parseTriState(body.allow_speak);
    const allowPost = parseTriState(body.allow_post);
    const allowReply = parseTriState(body.allow_reply);
    if (allowSpeak === null || allowPost === null || allowReply === null) return apiError(400, "GROUP_PERM_INVALID");
    const isModerator = Boolean(body.is_moderator);

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    let position: number;
    if (typeof body.position === "number" && Number.isInteger(body.position)) {
      position = body.position;
    } else {
      const maxPos = await env.DB.prepare("SELECT MAX(position) AS maxPos FROM server_groups").first<{ maxPos: number | null }>();
      position = (maxPos?.maxPos ?? -1) + 1;
    }
    await env.DB.prepare(
      "INSERT INTO server_groups (id, name, color, position, allow_speak, allow_post, allow_reply, is_moderator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, name, color, position, allowSpeak, allowPost, allowReply, isModerator ? 1 : 0, createdAt)
      .run();
    return json(
      toApiGroup({ id, name, color, position, allow_speak: allowSpeak, allow_post: allowPost, allow_reply: allowReply, is_moderator: isModerator ? 1 : 0, created_at: createdAt }),
      201
    );
  }

  if (method === "GET" && path === "/api/admin/server-groups") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const { results } = await env.DB.prepare("SELECT * FROM server_groups ORDER BY position ASC").all<ServerGroupRow>();
    return json({ groups: results.map(toApiGroup) });
  }

  if (method === "PATCH" && path === "/api/admin/server-groups") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    if (!Array.isArray(body.positions)) return apiError(400, "PAYLOAD_INVALID");
    const positions: { id: string; position: number }[] = [];
    for (const raw of body.positions) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (typeof entry.id !== "string" || typeof entry.position !== "number" || !Number.isInteger(entry.position)) {
        return apiError(400, "PAYLOAD_INVALID");
      }
      positions.push({ id: entry.id, position: entry.position });
    }
    await env.DB.batch(positions.map((p) => env.DB.prepare("UPDATE server_groups SET position = ? WHERE id = ?").bind(p.position, p.id)));

    const affected = new Set<string>();
    if (positions.length > 0) {
      const placeholders = positions.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT localpart FROM user_server_groups WHERE group_id IN (${placeholders})`
      )
        .bind(...positions.map((p) => p.id))
        .all<{ localpart: string }>();
      for (const row of results) affected.add(row.localpart);
    }
    await broadcastGroupRevoke(env, [...affected]);

    const { results } = await env.DB.prepare("SELECT * FROM server_groups ORDER BY position ASC").all<ServerGroupRow>();
    return json({ groups: results.map(toApiGroup) });
  }

  const serverGroupMatch = match("/api/admin/server-groups/:gid", path);
  if (serverGroupMatch && method === "PATCH") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const current = await env.DB.prepare("SELECT * FROM server_groups WHERE id = ?").bind(serverGroupMatch.gid!).first<ServerGroupRow>();
    if (!current) return apiError(404, "NOT_FOUND");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const next = { ...current };
    if ("name" in body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!isValidGroupName(name)) return apiError(400, "GROUP_NAME_INVALID");
      next.name = name;
    }
    if ("color" in body) {
      const color = parseOptionalColor(body.color);
      if (color === INVALID_COLOR) return apiError(400, "GROUP_COLOR_INVALID");
      next.color = color;
    }
    if ("position" in body) {
      if (typeof body.position !== "number" || !Number.isInteger(body.position)) return apiError(400, "PAYLOAD_INVALID");
      next.position = body.position;
    }
    if ("allow_speak" in body) {
      const v = parseTriState(body.allow_speak);
      if (v === null) return apiError(400, "GROUP_PERM_INVALID");
      next.allow_speak = v;
    }
    if ("allow_post" in body) {
      const v = parseTriState(body.allow_post);
      if (v === null) return apiError(400, "GROUP_PERM_INVALID");
      next.allow_post = v;
    }
    if ("allow_reply" in body) {
      const v = parseTriState(body.allow_reply);
      if (v === null) return apiError(400, "GROUP_PERM_INVALID");
      next.allow_reply = v;
    }
    if ("is_moderator" in body) {
      next.is_moderator = body.is_moderator ? 1 : 0;
    }

    await env.DB.prepare(
      "UPDATE server_groups SET name = ?, color = ?, position = ?, allow_speak = ?, allow_post = ?, allow_reply = ?, is_moderator = ? WHERE id = ?"
    )
      .bind(next.name, next.color, next.position, next.allow_speak, next.allow_post, next.allow_reply, next.is_moderator, next.id)
      .run();

    const { results } = await env.DB.prepare("SELECT localpart FROM user_server_groups WHERE group_id = ?")
      .bind(next.id)
      .all<{ localpart: string }>();
    await broadcastGroupRevoke(env, results.map((r) => r.localpart));

    return json(toApiGroup(next));
  }
  if (serverGroupMatch && method === "DELETE") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const current = await env.DB.prepare("SELECT id FROM server_groups WHERE id = ?").bind(serverGroupMatch.gid!).first<{ id: string }>();
    if (!current) return apiError(404, "NOT_FOUND");
    const { results } = await env.DB.prepare("SELECT localpart FROM user_server_groups WHERE group_id = ?")
      .bind(serverGroupMatch.gid!)
      .all<{ localpart: string }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_server_groups WHERE group_id = ?").bind(serverGroupMatch.gid!),
      env.DB.prepare("DELETE FROM server_groups WHERE id = ?").bind(serverGroupMatch.gid!),
    ]);
    await broadcastGroupRevoke(env, results.map((r) => r.localpart));
    return new Response(null, { status: 204, headers: cors() });
  }

  const serverGroupMemberMatch = match("/api/admin/server-groups/:gid/members/:localpart", path);
  if (serverGroupMemberMatch && method === "PUT") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const [group, user] = await Promise.all([
      env.DB.prepare("SELECT id FROM server_groups WHERE id = ?").bind(serverGroupMemberMatch.gid!).first<{ id: string }>(),
      env.DB.prepare("SELECT localpart FROM users WHERE localpart = ?").bind(serverGroupMemberMatch.localpart!).first<{ localpart: string }>(),
    ]);
    if (!group || !user) return apiError(404, "NOT_FOUND");
    await env.DB.prepare("INSERT INTO user_server_groups (localpart, group_id) VALUES (?, ?) ON CONFLICT(localpart, group_id) DO NOTHING")
      .bind(serverGroupMemberMatch.localpart!, serverGroupMemberMatch.gid!)
      .run();
    await broadcastGroupRevoke(env, [serverGroupMemberMatch.localpart!]);
    return new Response(null, { status: 204, headers: cors() });
  }
  if (serverGroupMemberMatch && method === "DELETE") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    await env.DB.prepare("DELETE FROM user_server_groups WHERE localpart = ? AND group_id = ?")
      .bind(serverGroupMemberMatch.localpart!, serverGroupMemberMatch.gid!)
      .run();
    await broadcastGroupRevoke(env, [serverGroupMemberMatch.localpart!]);
    return new Response(null, { status: 204, headers: cors() });
  }

  const serverGroupMembersListMatch = match("/api/admin/server-groups/:gid/members", path);
  if (serverGroupMembersListMatch && method === "GET") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const { results } = await env.DB.prepare("SELECT localpart FROM user_server_groups WHERE group_id = ?")
      .bind(serverGroupMembersListMatch.gid!)
      .all<{ localpart: string }>();
    return json({ localparts: results.map((r) => r.localpart) });
  }

  // Batch read-only actor -> groups lookup for member lists / message badges.
  // Guest-readable, same policy as GET /api/directory.
  if (method === "GET" && path === "/api/server-groups/members") {
    const config = await getInstanceConfig(env);
    if (!config.allow_guest_browsing) {
      const actor = await requireActor(request, env);
      if (!actor) return apiError(401, "AUTH_REQUIRED");
    }
    const raw = url.searchParams.get("localparts") ?? "";
    const localparts = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (localparts.length === 0 || localparts.length > 100) return apiError(400, "PAYLOAD_INVALID");

    const placeholders = localparts.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT usg.localpart AS localpart, g.id, g.name, g.color, g.position ` +
        `FROM user_server_groups usg JOIN server_groups g ON g.id = usg.group_id ` +
        `WHERE usg.localpart IN (${placeholders}) ORDER BY g.position ASC`
    )
      .bind(...localparts)
      .all<{ localpart: string; id: string; name: string; color: string | null; position: number }>();

    const groups: Record<string, { id: string; name: string; color: string | null }[]> = {};
    for (const localpart of localparts) groups[localpart] = [];
    for (const row of results) {
      groups[row.localpart]!.push({ id: row.id, name: row.name, color: row.color });
    }
    return json({ groups });
  }

  // ---- media upload, retrieval, deletion and storage quota ------------------------

  if (method === "POST" && path === "/api/media") {
    return handleMediaUpload(request, env);
  }

  // Public read: a media id is a random UUID, so the URL is the capability.
  // Browsers can't attach an Authorization header to an <img> subresource, so
  // gating this route makes every uploaded image unrenderable.
  const mediaGetMatch = match("/media/:id", path);
  if (mediaGetMatch && method === "GET") {
    const row = await env.DB.prepare("SELECT mime, r2_key FROM media WHERE id = ?")
      .bind(mediaGetMatch.id!)
      .first<{ mime: string; r2_key: string }>();
    if (!row) return apiError(404, "NOT_FOUND");
    const object = await env.MEDIA.get(row.r2_key);
    if (!object) return apiError(404, "NOT_FOUND");
    return new Response(object.body, {
      headers: {
        "Content-Type": row.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        ...cors(),
      },
    });
  }

  const mediaDeleteMatch = match("/api/media/:id", path);
  if (mediaDeleteMatch && method === "DELETE") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const row = await env.DB.prepare("SELECT owner_actor, r2_key, size FROM media WHERE id = ?")
      .bind(mediaDeleteMatch.id!)
      .first<{ owner_actor: string; r2_key: string; size: number }>();
    if (!row) return apiError(404, "NOT_FOUND");
    const isElevated = session.server_role === "owner" || session.server_role === "admin";
    if (row.owner_actor !== session.actor && !isElevated) return apiError(403, "FORBIDDEN");
    await env.MEDIA.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(mediaDeleteMatch.id!).run();
    await env.DB.prepare("UPDATE users SET avatar = NULL WHERE avatar = ? OR cover = ?")
      .bind(`/media/${mediaDeleteMatch.id!}`, `/media/${mediaDeleteMatch.id!}`)
      .run();
    return new Response(null, { status: 204, headers: cors() });
  }

  if (method === "GET" && path === "/api/me/storage") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const config = await getInstanceConfig(env);
    const used = await mediaUsage(env, actor);
    return json({ used, quota: config.user_storage_quota_bytes, max_file: config.max_file_bytes });
  }

  // ---- emote packs & emotes (v1: instance-level, admin-managed; each emote wraps
  // an existing media row) - :pack:name: rendering is a web-side concern, not this
  // API's ----------------------------------------------------------------------

  if (method === "GET" && path === "/api/emotes") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    return json({ packs: await listEmotePacks(env) });
  }

  if (method === "POST" && path === "/api/admin/emote-packs") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isValidEmoteName(name)) return apiError(400, "PACK_NAME_INVALID");

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.prepare("INSERT INTO emote_packs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, name, gate.actor, now)
        .run();
    } catch {
      return apiError(409, "PACK_NAME_TAKEN");
    }
    return json({ id, name, created_by: gate.actor, created_at: now, emotes: [] }, 201);
  }

  const emotePackDeleteMatch = match("/api/admin/emote-packs/:id", path);
  if (emotePackDeleteMatch && method === "DELETE") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const pack = await env.DB.prepare("SELECT id FROM emote_packs WHERE id = ?").bind(emotePackDeleteMatch.id!).first();
    if (!pack) return apiError(404, "NOT_FOUND");
    // Cascades the pack's emote rows only - the underlying media rows/objects
    // outlive the pack (proposal §11: asset lifecycle stays with 017's pipeline).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM emotes WHERE pack_id = ?").bind(emotePackDeleteMatch.id!),
      env.DB.prepare("DELETE FROM emote_packs WHERE id = ?").bind(emotePackDeleteMatch.id!),
    ]);
    return new Response(null, { status: 204, headers: cors() });
  }

  const emoteCreateMatch = match("/api/admin/emote-packs/:id/emotes", path);
  if (emoteCreateMatch && method === "POST") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const pack = await env.DB.prepare("SELECT id FROM emote_packs WHERE id = ?").bind(emoteCreateMatch.id!).first();
    if (!pack) return apiError(404, "NOT_FOUND");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isValidEmoteName(name)) return apiError(400, "EMOTE_NAME_INVALID");
    const mediaId = typeof body.media_id === "string" ? body.media_id : "";
    const media = await env.DB.prepare("SELECT id FROM media WHERE id = ?").bind(mediaId).first();
    if (!media) return apiError(400, "MEDIA_NOT_FOUND");

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.prepare("INSERT INTO emotes (id, pack_id, name, media_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, emoteCreateMatch.id!, name, mediaId, now)
        .run();
    } catch {
      return apiError(409, "EMOTE_NAME_TAKEN");
    }
    return json({ id, name, media_id: mediaId, url: `/media/${mediaId}` }, 201);
  }

  const emoteDeleteMatch = match("/api/admin/emotes/:id", path);
  if (emoteDeleteMatch && method === "DELETE") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const result = await env.DB.prepare("DELETE FROM emotes WHERE id = ?").bind(emoteDeleteMatch.id!).run();
    if (result.meta.changes === 0) return apiError(404, "NOT_FOUND");
    return new Response(null, { status: 204, headers: cors() });
  }

  const emoteExportMatch = match("/api/admin/emote-packs/:id/export", path);
  if (emoteExportMatch && method === "GET") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const pack = await env.DB.prepare("SELECT id, name FROM emote_packs WHERE id = ?")
      .bind(emoteExportMatch.id!)
      .first<{ id: string; name: string }>();
    if (!pack) return apiError(404, "NOT_FOUND");
    const { results } = await env.DB.prepare("SELECT name, media_id FROM emotes WHERE pack_id = ? ORDER BY created_at ASC")
      .bind(emoteExportMatch.id!)
      .all<{ name: string; media_id: string }>();
    return json({
      format: "omew-emotes/v1",
      pack: { name: pack.name },
      emotes: results.map((r) => ({ name: r.name, media_id: r.media_id })),
      metadata: { exported_at: Date.now() },
    });
  }

  if (method === "POST" && path === "/api/admin/emote-packs/import") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    if (body.format !== "omew-emotes/v1") return apiError(400, "FORMAT_INVALID");
    const packField = body.pack as Record<string, unknown> | undefined;
    const packName = typeof packField?.name === "string" ? packField.name.trim() : "";
    if (!isValidEmoteName(packName)) return apiError(400, "PACK_NAME_INVALID");
    const entries = Array.isArray(body.emotes) ? body.emotes : [];

    const packId = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.prepare("INSERT INTO emote_packs (id, name, created_by, created_at) VALUES (?, ?, ?, ?)")
        .bind(packId, packName, gate.actor, now)
        .run();
    } catch {
      return apiError(409, "PACK_NAME_TAKEN");
    }

    const imported: { id: string; name: string; media_id: string; url: string }[] = [];
    const skipped: { name: unknown; media_id: unknown; reason: string }[] = [];
    const seenNames = new Set<string>();

    for (const raw of entries) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const mediaId = typeof entry.media_id === "string" ? entry.media_id : "";
      if (!isValidEmoteName(name)) {
        skipped.push({ name: entry.name, media_id: entry.media_id, reason: "NAME_INVALID" });
        continue;
      }
      if (seenNames.has(name)) {
        skipped.push({ name, media_id: entry.media_id, reason: "NAME_DUPLICATE" });
        continue;
      }
      const media = await env.DB.prepare("SELECT id FROM media WHERE id = ?").bind(mediaId).first();
      if (!media) {
        skipped.push({ name, media_id: entry.media_id, reason: "MEDIA_NOT_FOUND" });
        continue;
      }
      seenNames.add(name);
      const emoteId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO emotes (id, pack_id, name, media_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(emoteId, packId, name, mediaId, now)
        .run();
      imported.push({ id: emoteId, name, media_id: mediaId, url: `/media/${mediaId}` });
    }

    return json({ pack: { id: packId, name: packName, emotes: imported }, skipped }, 201);
  }

  // ---- federation session (m0-protocol S7.2) - trust-list gate only, M6 does the rest ----

  if (method === "POST" && path === "/federation/session") {
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    // §7.1: the assertion's `iss` is the requesting identity server's domain.
    const iss = typeof body.iss === "string" ? body.iss : "";
    if (!iss) return apiError(400, "MALFORMED");

    const config = await getInstanceConfig(env);
    if (!isOriginTrusted(config, iss)) return apiError(403, "ORIGIN_NOT_TRUSTED");

    // Trusted origin: assertion signature/aud/jti/exp verification, guest identity
    // upsert and session issuance (§7.1-7.3) are M6 scope. Shape exists (same
    // placeholder convention as inbox.ts's 501) - only the trust-list gate is real.
    return apiError(501, "NOT_IMPLEMENTED");
  }

  // ---- stronghold CRUD ----------------------------------------------------------

  let m = match("/stronghold/:id", path);
  if (m && method === "GET") {
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const config = await stub.getConfig();
    if (!config) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    if (config.visibility === "private") {
      const denied = await requireMembership(request, env, m.id!);
      if (denied) return denied;
    }
    return json(config);
  }
  if (m && method === "PATCH") {
    const gate = await requireRole(request, env, m.id!, ["owner", "mod"]);
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return errorResponse(413, "OMEW_ENVELOPE_TOO_LARGE", "body too large or malformed");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const updated = await stub.updateConfig({
      name: asOptionalString(body.name),
      description: asOptionalString(body.description),
      visibility: body.visibility === "private" || body.visibility === "public" ? body.visibility : undefined,
      icon: asOptionalString(body.icon),
      avatar: asOptionalString(body.avatar),
    });
    if (!updated) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    return json(updated);
  }

  m = match("/stronghold/:id/rooms", path);
  if (m && method === "POST") {
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    if (!await stub.getConfig()) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    const gate = await requireRole(request, env, m.id!, ["owner", "mod"]);
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return errorResponse(413, "OMEW_ENVELOPE_TOO_LARGE", "body too large or malformed");
    const resId = String(body.res_id ?? "");
    const type = body.type === "section" ? "section" : "channel";
    const name = String(body.name ?? "");
    if (!RES_ID_RE.test(resId) || !name) return errorResponse(400, "OMEW_MALFORMED", "invalid res_id or name");
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
    if (await stub.getRoom(resId)) return errorResponse(409, "OMEW_ALREADY_EXISTS", "res_id taken");
    const room = await stub.createRoom(resId, type, name, capabilities, Boolean(body.restricted), asOptionalNumber(body.position));
    return json(room, 201);
  }
  if (m && method === "GET") {
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const config = await stub.getConfig();
    if (!config) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    if (config.visibility === "private") {
      const denied = await requireMembership(request, env, m.id!);
      if (denied) return denied;
    }
    const session = await requireSession(request, env);
    const role = session instanceof Response
      ? null
      : (await effectiveRole(env, m.id!, session.server_role, session.actor))?.role ?? null;
    const rooms = await stub.listRooms();
    return json(rooms.filter((room) => canAccessRestrictedRoom(role, room)));
  }

  m = match("/stronghold/:id/rooms/:resId", path);
  if (m && method === "PATCH") {
    const gate = await requireRole(request, env, m.id!, ["owner", "mod"]);
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return errorResponse(413, "OMEW_ENVELOPE_TOO_LARGE", "body too large or malformed");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const updated = await stub.updateRoom(m.resId!, {
      name: asOptionalString(body.name),
      restricted: typeof body.restricted === "boolean" ? body.restricted : undefined,
      position: asOptionalNumber(body.position),
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
    });
    if (!updated) return errorResponse(404, "OMEW_NOT_FOUND", "room not found");
    return json(updated);
  }
  if (m && method === "DELETE") {
    const gate = await requireRole(request, env, m.id!, ["owner", "mod"]);
    if (gate instanceof Response) return gate;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    await stub.deleteRoom(m.resId!);
    return new Response(null, { status: 204, headers: cors() });
  }

  // ---- members (dev convenience: no join_request flow yet, see stronghold-do.ts) --

  m = match("/stronghold/:id/members", path);
  if (m && method === "POST") {
    const gate = await requireRole(request, env, m.id!, ["owner", "mod"]);
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return errorResponse(413, "OMEW_ENVELOPE_TOO_LARGE", "body too large or malformed");
    const targetActor = String(body.actor ?? "");
    if (!targetActor.startsWith("@")) return errorResponse(400, "OMEW_MALFORMED", "invalid actor");
    const role: Role = body.role === "mod" ? "mod" : body.role === "owner" ? "owner" : "member";
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const member = await stub.addMember(targetActor, role, Number(body.deny ?? 0), Boolean(body.restricted));
    return json(member, 201);
  }
  if (m && method === "GET") {
    const gate = await requireRole(request, env, m.id!, ["owner", "mod", "member"]);
    if (gate instanceof Response) return gate;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    return json(await stub.listMembers());
  }

  // ---- stronghold + room creation, join/leave, my-strongholds --------------------
  // Same /api/* flat {error:CODE} shape as the settings/member surface below.
  // Distinct from the /stronghold/* dev-convenience routes further up: those take
  // an explicit id/res_id and full capability/position controls; these generate
  // ids and default to a bare {name, type} so a real client can create things
  // without inventing a slug.

  if (method === "POST" && path === "/api/strongholds") {
    if (fixedStronghold) return apiError(403, "STRONGHOLD_FIXED");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const actor = session.actor;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return apiError(400, "MALFORMED");
    const visibility = body.visibility === "private" ? "private" : "public";
    const description = asOptionalString(body.description);

    // m0-protocol §7.9: creation policy gate. server_owner/server_admin always
    // take the direct path, regardless of policy - they don't file applications
    // against themselves (§7.10 owner-equivalent standing).
    const config = await getInstanceConfig(env);
    const isElevated = session.server_role === "owner" || session.server_role === "admin";
    if (!isElevated && config.stronghold_creation_policy === "restricted" && !config.stronghold_creators.includes(actor)) {
      return apiError(403, "CREATION_RESTRICTED");
    }
    if (!isElevated && config.stronghold_creation_policy === "application") {
      const applicationId = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO stronghold_applications (id, actor, name, description, visibility, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      )
        .bind(applicationId, actor, name, description ?? null, visibility, now)
        .run();
      return json({ application_id: applicationId, state: "pending" }, 202);
    }

    const created = await createStrongholdWithDefaults(env, name, visibility, actor, description);
    return json(toApiConfig(created), 201);
  }

  if (method === "GET" && path === "/api/me/stronghold-applications") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const { results } = await env.DB.prepare(
      "SELECT id, actor, name, description, visibility, state, created_at, decided_by, decided_at " +
        "FROM stronghold_applications WHERE actor = ? ORDER BY created_at DESC"
    )
      .bind(actor)
      .all();
    return json({ applications: results });
  }

  if (method === "GET" && path === "/api/admin/stronghold-applications") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const state = url.searchParams.get("state");
    if (state && state !== "pending" && state !== "approved" && state !== "rejected") return apiError(400, "STATE_INVALID");
    const { results } = state
      ? await env.DB.prepare(
          "SELECT id, actor, name, description, visibility, state, created_at, decided_by, decided_at " +
            "FROM stronghold_applications WHERE state = ? ORDER BY created_at DESC"
        )
          .bind(state)
          .all()
      : await env.DB.prepare(
          "SELECT id, actor, name, description, visibility, state, created_at, decided_by, decided_at " +
            "FROM stronghold_applications ORDER BY created_at DESC"
        ).all();
    return json({ applications: results });
  }

  const applicationDecideMatch = match("/api/admin/stronghold-applications/:id", path);
  if (applicationDecideMatch && method === "PATCH") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    if (body.state !== "approved" && body.state !== "rejected") return apiError(400, "STATE_INVALID");

    const application = await env.DB.prepare(
      "SELECT id, actor, name, description, visibility, state FROM stronghold_applications WHERE id = ?"
    )
      .bind(applicationDecideMatch.id!)
      .first<{ id: string; actor: string; name: string; description: string | null; visibility: "public" | "private"; state: string }>();
    if (!application) return apiError(404, "NOT_FOUND");

    const now = Date.now();
    // Conditional UPDATE (not a separate read-then-write) so two concurrent
    // decisions on the same application can't both win.
    const decided = await env.DB.prepare(
      "UPDATE stronghold_applications SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'"
    )
      .bind(body.state, gate.actor, now, applicationDecideMatch.id!)
      .run();
    if (decided.meta.changes === 0) return apiError(409, "ALREADY_DECIDED");

    if (body.state === "rejected") {
      return json({ id: application.id, state: "rejected" });
    }
    const created = await createStrongholdWithDefaults(
      env,
      application.name,
      application.visibility,
      application.actor,
      application.description ?? undefined
    );
    return json({ id: application.id, state: "approved", stronghold: toApiConfig(created) });
  }

  // rename a stronghold's URL short-name. Server owner/admin only -
  // same gate as every other /api/admin/* route in this file, deliberately not
  // the per-stronghold owner/mod effectiveRole (a stronghold's own owner/mod
  // MUST NOT be able to hijack another stronghold's slug or grief their own).
  const slugMatch = match("/api/admin/strongholds/:id/slug", path);
  if (slugMatch && method === "PATCH") {
    if (fixedStronghold && slugMatch.id === fixedStronghold.id) return apiError(403, "STRONGHOLD_FIXED");
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const slug = typeof body.slug === "string" ? body.slug : "";
    if (!SLUG_RE.test(slug)) return apiError(400, "MALFORMED");

    const stub = env.STRONGHOLD_DO.getByName(slugMatch.id!);
    const config = await stub.getConfig();
    if (!config) return apiError(404, "NOT_FOUND");
    if (config.slug === slug) return json({ id: config.id, slug });

    // The index table's stronghold_id column is UNIQUE (one slug per stronghold),
    // so the old row has to go before the new one can be inserted - if the new
    // slug turns out to be taken, put the old mapping back rather than leaving
    // this stronghold with no slug row at all.
    await env.DB.prepare("DELETE FROM stronghold_slug_index WHERE stronghold_id = ?").bind(config.id).run();
    try {
      await env.DB.prepare("INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)")
        .bind(slug, config.id)
        .run();
    } catch {
      await env.DB.prepare("INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)")
        .bind(config.slug, config.id)
        .run()
        .catch(() => {});
      return apiError(409, "ALREADY_EXISTS");
    }
    const updated = await stub.updateSlug(slug);
    return json({ id: updated!.id, slug: updated!.slug });
  }

  m = match("/api/stronghold/:id/rooms", path);
  if (m && method === "POST") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    if (!await stub.getConfig()) return apiError(404, "NOT_FOUND");
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return apiError(400, "MALFORMED");
    const type: RoomType = body.type === "section" ? "section" : "channel";

    const resId = generateResId();
    const room = await stub.createRoom(resId, type, name, ["text"], false);
    return json(toApiRoom(room), 201);
  }
  // The only other room listing under the /api/* flat-shape surface is
  // embedded per-actor in GET /api/me/strongholds (auth-only, "my strongholds") -
  // this is the by-id equivalent, open to a guest on a public stronghold.
  if (m && method === "GET") {
    const gate = await resolveGuestOrMember(request, env, m.id!);
    if (gate instanceof Response) return gate;
    const strongholdId = m.id!;
    const stub = env.STRONGHOLD_DO.getByName(strongholdId);
    const rooms = await stub.listRooms();
    const visible = rooms.filter((room) => !roomBlockedForGate(gate, room));
    const projected = await Promise.all(
      visible.map(async (r) => {
        if (r.type !== "section") return toApiRoom(r);
        const roomRef = `${strongholdId}/${typeToKind(r.type)}/${r.res_id}`;
        const roomStub = env.ROOM_DO.getByName(roomRef);
        const postCount = await roomStub.countPosts();
        return toApiRoom(r, postCount);
      })
    );
    return json(projected);
  }

  m = match("/api/stronghold/:id/rooms/:resId", path);
  if (m && method === "PATCH") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const patch: { name?: string; description?: string | null; restricted?: boolean; position?: number } = {};
    if ("name" in body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return apiError(400, "MALFORMED");
      patch.name = name;
    }
    if ("description" in body) {
      const description = asOptionalDescription(body.description);
      if (description === INVALID_DESCRIPTION) return apiError(400, "MALFORMED");
      patch.description = description;
    }
    if ("restricted" in body) {
      if (typeof body.restricted !== "boolean") return apiError(400, "MALFORMED");
      patch.restricted = body.restricted;
    }
    if ("position" in body) {
      if (typeof body.position !== "number") return apiError(400, "MALFORMED");
      patch.position = body.position;
    }
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const updated = await stub.updateRoom(m.resId!, patch);
    if (!updated) return apiError(404, "NOT_FOUND");
    return json(toApiRoom(updated));
  }
  if (m && method === "DELETE") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const room = await stub.getRoom(m.resId!);
    if (!room) return apiError(404, "NOT_FOUND");
    const rooms = await stub.listRooms();
    const sameType = rooms.filter((r) => r.type === room.type);
    if (sameType.length <= 1) return apiError(409, "LAST_ROOM_OF_TYPE");
    await stub.deleteRoom(m.resId!);
    return new Response(null, { status: 204, headers: cors() });
  }

  m = match("/api/stronghold/:id/join", path);
  if (m && method === "POST") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const config = await stub.getConfig();
    if (!config) return apiError(404, "NOT_FOUND");

    const existing = await stub.getMember(actor);
    if (existing) {
      if (existing.banned_at) return apiError(403, "FORBIDDEN");
      const profiles = await actorProfiles(env, [actor]);
      return json(toMemberEntry(existing, profiles.get(actor)));
    }
    // §7.2/§9 placeholder: private strongholds need a join_request flow (M6-era
    // federation feature); until then this is the explicit "not implemented yet"
    // signal rather than a silent 403 FORBIDDEN.
    if (config.visibility === "private") return apiError(403, "JOIN_REQUIRES_APPLICATION");

    const member = await stub.addMember(actor, "member", 0, false);
    const profiles = await actorProfiles(env, [actor]);
    return json(toMemberEntry(member, profiles.get(actor)), 201);
  }

  m = match("/api/stronghold/:id/leave", path);
  if (m && method === "POST") {
    const actor = await requireActor(request, env);
    if (!actor) return apiError(401, "AUTH_REQUIRED");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const member = await stub.getMember(actor);
    if (!member) return apiError(404, "NOT_FOUND");
    if (member.role === "owner") return apiError(400, "OWNER_MUST_TRANSFER");
    await stub.removeMember(actor);
    return new Response(null, { status: 204, headers: cors() });
  }

  if (method === "GET" && path === "/api/me/strongholds") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return apiError(401, "AUTH_REQUIRED");
    const actor = session.actor;
    const isServerAdmin = session.server_role === "owner" || session.server_role === "admin";
    const { results } = isServerAdmin
      ? await env.DB.prepare("SELECT DISTINCT stronghold_id FROM stronghold_slug_index ORDER BY stronghold_id")
        .all<{ stronghold_id: string }>()
      : await env.DB.prepare("SELECT DISTINCT stronghold_id FROM stronghold_member_index WHERE actor = ? ORDER BY stronghold_id")
        .bind(actor)
        .all<{ stronghold_id: string }>();
    const strongholdIds = fixedStronghold
      ? [fixedStronghold.id]
      : [...new Set(results.map((row) => row.stronghold_id))];
    const nodes = await Promise.all(
      strongholdIds.map(async (strongholdId) => {
        const stub = env.STRONGHOLD_DO.getByName(strongholdId);
        const [config, rooms] = await Promise.all([stub.getConfig(), stub.listRooms()]);
        if (!config) return null;
        const eff = await effectiveRole(env, strongholdId, session.server_role, actor);
        if (!eff) return null;
        const visibleRooms = rooms.filter((room) => canAccessRestrictedRoom(eff.role, room));
        return {
          id: config.id,
          name: config.name,
          avatar: config.avatar,
          cover: config.cover,
          slug: config.slug,
          // post_count is deliberately absent here: it costs one DO call per
          // section and this list loads on every app start. The by-id rooms
          // endpoint carries it for the places that actually show counts.
          rooms: visibleRooms.map((room) => ({ id: room.res_id, name: room.name, type: room.type, description: room.description })),
        };
      })
    );
    return json(nodes.filter((n): n is NonNullable<typeof n> => n != null));
  }

  // ---- stronghold settings & member management --------------------------------
  // /api/stronghold/* surface: flat {error:CODE} shape, matching /api/register et
  // al. above - distinct from the /stronghold/* dev-convenience routes above it, which
  // are untouched and keep serving stronghold/room creation, WS tokens and upgrades.

  m = match("/api/stronghold/:id/feature-restrictions", path);
  if (m && method === "GET") {
    const gate = await resolveGuestOrMember(request, env, m.id!);
    if (gate instanceof Response) return gate;
    const snapshot = await env.STRONGHOLD_DO.getByName(m.id!).getFeatureRestrictions();
    if (!snapshot) return apiError(404, "NOT_FOUND");
    return json(featureRestrictionsResponse(snapshot));
  }
  m = match("/api/stronghold/:id/feature-restrictions/owner", path);
  if (m && method === "PATCH") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const [config, member] = await Promise.all([stub.getConfig(), stub.getMember(session.actor)]);
    // This is deliberately an actual-owner gate, not effectiveRole: neither a
    // moderator nor the server-role overlay may change the owner's policy.
    if (!config || config.owner_actor !== session.actor || member?.role !== "owner" || member.banned_at) return apiError(403, "FORBIDDEN");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const feature = readRestrictedFeature(body.feature);
    if (!feature || typeof body.paused !== "boolean") return apiError(400, "CONFIG_INVALID");
    const expiresAt = readRestrictionExpiry(body);
    if (expiresAt === "invalid") return apiError(400, "EXPIRY_INVALID");
    let snapshot: FeatureRestrictionSnapshot | null;
    try {
      snapshot = await stub.updateOwnerFeatureRestriction(feature, body.paused, expiresAt);
    } catch {
      return apiError(503, "FEATURE_RESTRICTION_SYNC_FAILED");
    }
    if (!snapshot) return apiError(404, "NOT_FOUND");
    return json(featureRestrictionsResponse(snapshot));
  }

  m = match("/api/stronghold/:id/feature-restrictions/server", path);
  if (m && method === "PATCH") {
    const gate = await requireServerRole(request, env, "admin");
    if (gate instanceof Response) return gate;
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const feature = readRestrictedFeature(body.feature);
    const override = body.mode as ServerFeatureOverride;
    if (!feature || (override !== "inherit" && override !== "force_allow" && override !== "force_pause")) return apiError(400, "CONFIG_INVALID");
    const expiresAt = readRestrictionExpiry(body);
    if (expiresAt === "invalid") return apiError(400, "EXPIRY_INVALID");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    if (!(await stub.getConfig())) return apiError(404, "NOT_FOUND");
    const persistedExpiry = override === "inherit" ? null : expiresAt;
    const previous = await env.DB.prepare(
      "SELECT mode, expires_at, updated_by, updated_at FROM stronghold_feature_overrides WHERE stronghold_id = ? AND feature = ?"
    ).bind(m.id!, feature).first<{ mode: ServerFeatureOverride; expires_at: number | null; updated_by: string; updated_at: number }>();
    await env.DB.prepare(
      "INSERT INTO stronghold_feature_overrides (stronghold_id, feature, mode, expires_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(stronghold_id, feature) DO UPDATE SET mode = excluded.mode, expires_at = excluded.expires_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
    ).bind(m.id!, feature, override, persistedExpiry, gate.actor, Date.now()).run();
    let snapshot: FeatureRestrictionSnapshot | null;
    try {
      snapshot = await stub.refreshFeatureRestrictions();
    } catch {
      if (previous) {
        await env.DB.prepare(
          "UPDATE stronghold_feature_overrides SET mode = ?, expires_at = ?, updated_by = ?, updated_at = ? WHERE stronghold_id = ? AND feature = ?"
        ).bind(previous.mode, previous.expires_at, previous.updated_by, previous.updated_at, m.id!, feature).run();
      } else {
        await env.DB.prepare("DELETE FROM stronghold_feature_overrides WHERE stronghold_id = ? AND feature = ?").bind(m.id!, feature).run();
      }
      return apiError(503, "FEATURE_RESTRICTION_SYNC_FAILED");
    }
    if (!snapshot) return apiError(404, "NOT_FOUND");
    return json(featureRestrictionsResponse(snapshot));
  }

  m = match("/api/stronghold/:id/config", path);
  if (m && method === "GET") {
    const gate = await resolveGuestOrMember(request, env, m.id!);
    if (gate instanceof Response) return gate;
    return json(toApiConfig(gate.config));
  }
  if (m && method === "PATCH") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    // §9 / proposal: visibility is owner-only, every other config field is owner/mod.
    if ("visibility" in body && eff.role !== "owner") return apiError(403, "FORBIDDEN");

    const patch: Partial<
      Pick<ConfigRow, "name" | "description" | "visibility" | "avatar" | "cover" | "allow_message_edit" | "allow_message_retract" | "edit_window_secs">
    > = {};
    if ("name" in body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 32) return apiError(400, "CONFIG_INVALID");
      patch.name = name;
    }
    if ("description" in body) {
      if (body.description !== null && typeof body.description !== "string") return apiError(400, "CONFIG_INVALID");
      patch.description = body.description as string | null;
    }
    if ("cover" in body) {
      if (body.cover !== null && typeof body.cover !== "string") return apiError(400, "CONFIG_INVALID");
      patch.cover = body.cover as string | null;
    }
    if ("avatar" in body) {
      if (body.avatar !== null && typeof body.avatar !== "string") return apiError(400, "CONFIG_INVALID");
      patch.avatar = body.avatar as string | null;
    }
    if ("visibility" in body) {
      if (body.visibility !== "public" && body.visibility !== "private") return apiError(400, "CONFIG_INVALID");
      patch.visibility = body.visibility;
    }
    if ("allow_message_edit" in body) {
      if (typeof body.allow_message_edit !== "boolean") return apiError(400, "CONFIG_INVALID");
      patch.allow_message_edit = body.allow_message_edit ? 1 : 0;
    }
    if ("allow_message_retract" in body) {
      if (typeof body.allow_message_retract !== "boolean") return apiError(400, "CONFIG_INVALID");
      patch.allow_message_retract = body.allow_message_retract ? 1 : 0;
    }
    if ("edit_window_secs" in body) {
      if (typeof body.edit_window_secs !== "number" || !Number.isInteger(body.edit_window_secs) || body.edit_window_secs < 0) {
        return apiError(400, "CONFIG_INVALID");
      }
      patch.edit_window_secs = body.edit_window_secs;
    }

    const updated = await stub.updateConfig(patch);
    if (!updated) return apiError(404, "NOT_FOUND");
    return json(toApiConfig(updated));
  }

  // A stronghold is a graph of one StrongholdDO, one RoomDO per room,
  // and several D1 discovery/federation indexes. Its actual owner may erase
  // that graph, and the server owner has an explicit instance-governance
  // override. A server admin does not inherit this irreversible operation.
  m = match("/api/stronghold/:id", path);
  if (m && method === "DELETE") {
    if (fixedStronghold) return apiError(403, "STRONGHOLD_FIXED");
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const strongholdId = m.id!;
    const stub = env.STRONGHOLD_DO.getByName(strongholdId);
    const [config, requester] = await Promise.all([stub.getConfig(), stub.getMember(session.actor)]);
    if (!config) return apiError(404, "NOT_FOUND");
    const isActualOwner = config.owner_actor === session.actor && requester?.role === "owner" && !requester.banned_at;
    if (!isActualOwner && session.server_role !== "owner") return apiError(403, "FORBIDDEN");

    // Purge children first.  A failed child purge leaves the authoritative
    // StrongholdDO intact, so a retry is safe and cannot strand inaccessible
    // room state behind an already-deleted config.
    const rooms = await stub.listRoomsForDeletion();
    const archivePrefix = `${strongholdId}/`;
    const { results: archiveRows } = await env.DB.prepare(
      "SELECT DISTINCT scoped.r2_key FROM archive_index scoped " +
        "WHERE (scoped.do_key = ? OR instr(scoped.do_key, ?) = 1) " +
        "AND NOT EXISTS (SELECT 1 FROM archive_index other WHERE other.r2_key = scoped.r2_key " +
        "AND NOT (other.do_key = ? OR instr(other.do_key, ?) = 1))"
    ).bind(strongholdId, archivePrefix, strongholdId, archivePrefix).all<{ r2_key: string }>();
    await Promise.all(
      rooms.map((room) => env.ROOM_DO.getByName(`${strongholdId}/${typeToKind(room.type)}/${room.res_id}`).purgeForStrongholdDeletion())
    );

    // A failed archive deletion keeps the config and indexes intact so the
    // owner can retry; child RoomDO deletion is idempotent.
    await Promise.all([...new Set(archiveRows.map((row) => row.r2_key))].map((key) => env.MEDIA.delete(key)));

    // D1 is only an index/auxiliary state for this graph.  These deletes are
    // deliberately scoped by the stronghold id; media is not touched because
    // media.owner_actor is an account owner, not a stronghold ownership link.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stronghold_member_index WHERE stronghold_id = ?").bind(strongholdId),
      env.DB.prepare("DELETE FROM stronghold_slug_index WHERE stronghold_id = ?").bind(strongholdId),
      env.DB.prepare("DELETE FROM stronghold_directory_index WHERE stronghold_id = ?").bind(strongholdId),
      env.DB.prepare("DELETE FROM guest_member_state WHERE stronghold_id = ?").bind(strongholdId),
      env.DB.prepare("DELETE FROM archive_index WHERE do_key = ? OR instr(do_key, ?) = 1").bind(strongholdId, `${strongholdId}/`),
    ]);
    await stub.purgeForStrongholdDeletion();
    return new Response(null, { status: 204, headers: cors() });
  }

  m = match("/api/stronghold/:id/members", path);
  if (m && method === "GET") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const requester = await stub.getMember(session.actor);
    if (!overlayRole(session.server_role, requester)) return apiError(403, "FORBIDDEN");

    const tab = url.searchParams.get("tab") ?? "all";
    if (tab !== "all" && tab !== "restricted" && tab !== "banned") return apiError(400, "TAB_INVALID");
    const after = url.searchParams.get("after");

    const all = await stub.listMembers();
    const filtered =
      tab === "banned"
        ? all.filter((entry) => entry.banned_at != null)
        : tab === "restricted"
          ? all.filter((entry) => entry.banned_at == null && entry.deny !== 0)
          : all.filter((entry) => entry.banned_at == null);

    const { page, next_cursor } = paginateMembers(filtered, after);
    const actors = page.map((entry) => entry.actor);
    const profiles = await actorProfiles(env, actors);
    const entries = page.map((entry) => toMemberEntry(entry, profiles.get(entry.actor)));
    return json({ entries, next_cursor });
  }

  m = match("/api/stronghold/:id/members/:actor", path);
  if (m && method === "PATCH") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const target = await stub.getMember(m.actor!);
    if (!target) return apiError(404, "NOT_FOUND");
    if (target.role === "owner") return apiError(403, "FORBIDDEN");

    let role: "mod" | "member" | undefined;
    if ("role" in body) {
      // §9: appointing/dismissing a mod is owner-only.
      if (eff.role !== "owner") return apiError(403, "FORBIDDEN");
      if (body.role !== "mod" && body.role !== "member") return apiError(400, "ROLE_INVALID");
      role = body.role;
    }

    let deny: number | undefined;
    if ("deny" in body) {
      if (typeof body.deny !== "number" || !Number.isInteger(body.deny) || body.deny < 0) return apiError(400, "CONFIG_INVALID");
      deny = body.deny;
      // §9: deny only ever applies to a `member`. Denying a mod - whether or not
      // this same request also tries to demote them - MUST fail; the caller has
      // to demote first in a separate request, then apply deny in a second one.
      if (deny !== 0 && target.role === "mod") return apiError(400, "DENY_ON_MOD");
    }

    const updated = await stub.updateMember(m.actor!, { role, deny });
    if (!updated) return apiError(404, "NOT_FOUND");
    const profiles = await actorProfiles(env, [updated.actor]);
    return json(toMemberEntry(updated, profiles.get(updated.actor)));
  }
  if (m && method === "DELETE") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");

    const target = await stub.getMember(m.actor!);
    if (!target) return apiError(404, "NOT_FOUND");
    if (target.role === "owner") return apiError(403, "FORBIDDEN");
    if (target.role === "mod" && eff.role !== "owner") return apiError(403, "FORBIDDEN");

    await stub.removeMember(m.actor!);
    return new Response(null, { status: 204, headers: cors() });
  }

  m = match("/api/stronghold/:id/bans", path);
  if (m && method === "GET") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const entries = await stub.listBans();
    return json({ entries });
  }

  m = match("/api/stronghold/:id/bans/:actor", path);
  if (m && method === "PUT") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");

    const target = await stub.getMember(m.actor!);
    if (!target) return apiError(404, "NOT_FOUND");
    if (target.role === "owner") return apiError(403, "FORBIDDEN");
    if (target.role === "mod" && eff.role !== "owner") return apiError(403, "FORBIDDEN");

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const expiresAt = readBanExpiry(body);
    if (expiresAt === "invalid") return apiError(400, "EXPIRY_INVALID");
    const banned = await stub.banMember(m.actor!, session.actor, expiresAt);
    if (!banned) return apiError(404, "NOT_FOUND");
    return json({ actor: banned.actor, operator: session.actor, banned_at: banned.banned_at, expires_at: banned.expires_at });
  }
  if (m && method === "DELETE") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff || (eff.role !== "owner" && eff.role !== "mod")) return apiError(403, "FORBIDDEN");
    const stub = env.STRONGHOLD_DO.getByName(m.id!);

    await stub.unbanMember(m.actor!);
    return new Response(null, { status: 204, headers: cors() });
  }

  m = match("/api/stronghold/:id/transfer", path);
  if (m && method === "POST") {
    if (fixedStronghold) return apiError(403, "STRONGHOLD_FIXED");
    // m0-protocol §7.10: the one permission gate the server_owner/server_admin
    // overlay does NOT extend to - only the real stronghold owner or the actual
    // server_owner (not server_admin) may transfer ownership.
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const stub = env.STRONGHOLD_DO.getByName(m.id!);
    const requester = await stub.getMember(session.actor);
    const isRealOwner = requester != null && !requester.banned_at && requester.role === "owner";
    if (!isRealOwner && session.server_role !== "owner") return apiError(403, "FORBIDDEN");

    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");
    const to = typeof body.to === "string" ? body.to : "";
    if (!to) return apiError(400, "MALFORMED");

    const config = await stub.getConfig();
    if (!config) return apiError(404, "NOT_FOUND");
    const updated = await stub.transferOwnership(config.owner_actor, to);
    if (!updated) return apiError(400, "TARGET_NOT_MEMBER");
    return json(toApiConfig(updated));
  }

  // ---- room item edit/retract ("edit"/"retract" HTTP entry points; the WS frame
  // types stay item.update/item.delete per m0-protocol S5.4 namespacing) ----------

  m = match("/api/stronghold/:id/rooms/:resId/items/:seq", path);
  if (m && method === "PATCH") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    const member = await strongholdStub.getMember(session.actor);
    // Editing someone else's item is author-only regardless of role (room-do.ts) -
    // the server-role overlay only needs to clear this membership/ban gate, not
    // grant any extra edit rights.
    if (!overlayRole(session.server_role, member)) return apiError(403, "FORBIDDEN");
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return apiError(404, "NOT_FOUND");
    const seq = Number(m.seq);
    if (!Number.isFinite(seq)) return apiError(400, "MALFORMED");
    const body = await readJsonBody(request);
    if (!body) return apiError(413, "PAYLOAD_INVALID");

    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    const result = await roomStub.editItem(session.actor, roomRef, seq, body.content);
    if (!result.ok) return apiError(roomErrorStatus(result.code), result.code);
    return json({ seq: result.seq, target_seq: seq });
  }
  if (m && method === "DELETE") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    // Retract's moderator-override check (room-do.ts) needs the
    // group-synthesized effective role, not just the raw member row.
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff) return apiError(403, "FORBIDDEN");
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return apiError(404, "NOT_FOUND");
    const seq = Number(m.seq);
    if (!Number.isFinite(seq)) return apiError(400, "MALFORMED");

    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    const result = await roomStub.retractItem(session.actor, eff.role, roomRef, seq);
    if (!result.ok) return apiError(roomErrorStatus(result.code), result.code);
    return json({ seq: result.seq, target_seq: seq });
  }

  // ---- member-to-member private messaging and ordinary user blocks ------------

  // Both actions are scoped to a shared stronghold membership at the API
  // boundary. A user block itself is global, but it never reuses (or changes)
  // administrator account/stronghold bans.
  m = match("/api/stronghold/:id/blocks/:actor", path);
  if (m && (method === "GET" || method === "PUT" || method === "DELETE")) {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const target = m.actor!;
    if (!isActorIdentifier(target)) return apiError(400, "MALFORMED");
    if (session.actor === target) return apiError(400, "SELF_TARGET");
    const permitted = await requireDirectMessageMembership(env, m.id!, session, target);
    if (permitted instanceof Response) return permitted;

    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT 1 FROM user_blocks WHERE blocker_actor = ? AND blocked_actor = ?"
      ).bind(session.actor, target).first();
      return json({ blocked: Boolean(row) });
    }
    if (method === "PUT") {
      await env.DB.prepare(
        "INSERT INTO user_blocks (blocker_actor, blocked_actor, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(blocker_actor, blocked_actor) DO NOTHING"
      ).bind(session.actor, target, Date.now()).run();
      return json({ blocked: true });
    }
    await env.DB.prepare(
      "DELETE FROM user_blocks WHERE blocker_actor = ? AND blocked_actor = ?"
    ).bind(session.actor, target).run();
    return json({ blocked: false });
  }

  m = match("/api/stronghold/:id/direct-messages/:actor", path);
  if (m && (method === "GET" || method === "POST")) {
    const session = await requireSession(request, env);
    if (session instanceof Response) return session;
    const target = m.actor!;
    if (!isActorIdentifier(target)) return apiError(400, "MALFORMED");
    if (session.actor === target) return apiError(400, "SELF_TARGET");
    const permitted = await requireDirectMessageMembership(env, m.id!, session, target);
    if (permitted instanceof Response) return permitted;

    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, sender_actor, recipient_actor, body, created_at FROM (" +
          "SELECT id, sender_actor, recipient_actor, body, created_at FROM direct_messages " +
          "WHERE stronghold_id = ? AND ((sender_actor = ? AND recipient_actor = ?) OR (sender_actor = ? AND recipient_actor = ?)) " +
          "ORDER BY created_at DESC LIMIT 100" +
        ") ORDER BY created_at ASC"
      ).bind(m.id!, session.actor, target, target, session.actor).all<{
        id: string; sender_actor: string; recipient_actor: string; body: string; created_at: number;
      }>();
      return json({ messages: results });
    }

    const body = await readJsonBody(request);
    if (!body || typeof body.body !== "string") return apiError(400, "MESSAGE_INVALID");
    const text = body.body.trim();
    if (!text || text.length > 2_000) return apiError(400, "MESSAGE_INVALID");
    const blocked = await env.DB.prepare(
      "SELECT 1 FROM user_blocks WHERE (blocker_actor = ? AND blocked_actor = ?) OR (blocker_actor = ? AND blocked_actor = ?)"
    ).bind(session.actor, target, target, session.actor).first();
    if (blocked) return apiError(403, "DIRECT_MESSAGE_BLOCKED");
    const message = {
      id: crypto.randomUUID(), stronghold_id: m.id!, sender_actor: session.actor,
      recipient_actor: target, body: text, created_at: Date.now(),
    };
    await env.DB.prepare(
      "INSERT INTO direct_messages (id, stronghold_id, sender_actor, recipient_actor, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(message.id, message.stronghold_id, message.sender_actor, message.recipient_actor, message.body, message.created_at).run();
    return json({ id: message.id, sender_actor: message.sender_actor, recipient_actor: message.recipient_actor, body: message.body, created_at: message.created_at }, 201);
  }

  // ---- user profile lookup (登录可读) --------------------------------------------

  m = match("/api/users/:actor", path);
  if (m && method === "GET") {
    const requester = await requireActor(request, env);
    if (!requester) return apiError(401, "AUTH_REQUIRED");
    const target = m.actor!;
    if (!target.startsWith("@") || !target.includes(":")) return apiError(400, "MALFORMED");

    if (domainOfActor(target) === instanceDomain(env)) {
      const row = await env.DB.prepare("SELECT display_name, avatar, cover, bio, created_at FROM users WHERE localpart = ?")
        .bind(localpartOfActor(target))
        .first<{ display_name: string; avatar: string | null; cover: string | null; bio: string | null; created_at: number }>();
      if (!row) return apiError(404, "NOT_FOUND");
      return json({ actor: target, display_name: row.display_name, avatar: row.avatar, cover: row.cover, bio: row.bio, created_at: row.created_at, is_guest: false });
    }

    const row = await env.DB.prepare(
      "SELECT display_name, avatar, first_seen_at, registered_origin FROM guest_identity WHERE actor = ?"
    )
      .bind(target)
      .first<{ display_name: string | null; avatar: string | null; first_seen_at: number; registered_origin: string }>();
    if (!row) return apiError(404, "NOT_FOUND");
    return json({
      actor: target,
      display_name: row.display_name ?? target,
      avatar: row.avatar,
      cover: null,
      bio: null,
      created_at: row.first_seen_at,
      is_guest: true,
      home_domain: row.registered_origin,
    });
  }

  // ---- WS token minting (m0-protocol S7.3 / S9) ------------------------------------

  m = match("/stronghold/:id/rooms/:resId/token", path);
  if (m && method === "POST") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return errorResponse(401, "OMEW_SESSION_INVALID", "auth required");
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    if (!await strongholdStub.getConfig()) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    // Role/deny baked into the token are the group-synthesized
    // effective values (permissions.ts) - RoomDO itself is unchanged, it just
    // reads whatever role/deny the token carries.
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff) return errorResponse(403, "OMEW_BANNED", "not a member or banned");
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return errorResponse(404, "OMEW_ROOM_NOT_FOUND", "room not found");
    if (!canAccessRestrictedRoom(eff.role, room)) {
      return errorResponse(404, "OMEW_ROOM_NOT_FOUND", "room not found");
    }
    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const claims: RoomTokenClaims = {
      v: 1, typ: "room", actor: session.actor, room: roomRef, role: eff.role, deny: eff.deny,
      exp: nowS() + ROOM_TOKEN_TTL_S, jti: newJti(),
    };
    const token = await signToken(claims, env.DEV_TOKEN_SECRET);
    return json({ token, room: roomRef, exp: claims.exp });
  }

  m = match("/stronghold/:id/tips-token", path);
  if (m && method === "POST") {
    const session = await requireSession(request, env);
    if (session instanceof Response) return errorResponse(401, "OMEW_SESSION_INVALID", "auth required");
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    if (!await strongholdStub.getConfig()) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");
    const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
    if (!eff) return errorResponse(403, "OMEW_BANNED", "not a member or banned");
    const claims: StrongholdTokenClaims = {
      v: 1, typ: "stronghold", actor: session.actor, stronghold: m.id!, role: eff.role,
      exp: nowS() + ROOM_TOKEN_TTL_S, jti: newJti(),
    };
    const token = await signToken(claims, env.DEV_TOKEN_SECRET);
    return json({ token, stronghold: m.id!, exp: claims.exp });
  }

  // ---- WS upgrade forwarding (proposal S4.1: "Worker (API): ... 房间 WS 升级转发") ----

  m = match("/stronghold/:id/rooms/:resId/ws", path);
  if (m && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return errorResponse(426, "OMEW_UPGRADE_REQUIRED", "expected websocket upgrade");
    }
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return errorResponse(404, "OMEW_ROOM_NOT_FOUND", "room not found");
    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    return roomStub.fetch(request);
  }

  m = match("/stronghold/:id/tips/ws", path);
  if (m && method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return errorResponse(426, "OMEW_UPGRADE_REQUIRED", "expected websocket upgrade");
    }
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    return strongholdStub.fetch(request);
  }

  // ---- history proxy (S5.3: seq-anchored pagination) -------------------------------

  m = match("/stronghold/:id/rooms/:resId/history", path);
  if (m && method === "GET") {
    // This route predates the flat {error:CODE} /api/* surface and
    // keeps its own nested {error:{code,message}} shape (see the note atop this
    // file), so it can't reuse resolveGuestOrMember/apiError - same guest gate,
    // shaped to match its existing error responses instead.
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    const config = await strongholdStub.getConfig();
    if (!config) return errorResponse(404, "OMEW_NOT_FOUND", "stronghold not found");

    const session = await requireSession(request, env);
    let requester: string | null = null;
    let role: Role | null = null;
    if (!(session instanceof Response)) {
      const member = await strongholdStub.getMember(session.actor);
      const eff = await effectiveRole(env, m.id!, session.server_role, session.actor);
      if (eff) {
        requester = session.actor;
        role = eff.role;
      } else if (member) {
        // A banned member is not an anonymous visitor and must not regain
        // read access by falling through to the public guest path.
        return errorResponse(403, "OMEW_BANNED", "not a member or banned");
      } else {
        // Authenticated accounts without a membership get the same public
        // read-only preview as an unauthenticated guest. Keep requester null
        // so private/member-only content cannot be selected by RoomDO.
        const policy = await getInstanceConfig(env);
        if (!(policy.allow_guest_browsing && config.visibility === "public")) {
          return errorResponse(403, "OMEW_BANNED", "not a member or banned");
        }
      }
    } else {
      const policy = await getInstanceConfig(env);
      if (!(policy.allow_guest_browsing && config.visibility === "public")) {
        return errorResponse(401, "OMEW_SESSION_INVALID", "auth required");
      }
    }

    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return errorResponse(404, "OMEW_ROOM_NOT_FOUND", "room not found");
    if (!canAccessRestrictedRoom(role, room)) return errorResponse(404, "OMEW_ROOM_NOT_FOUND", "room not found");
    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    const items = await roomStub.getHistory(before, limit, requester);
    return json({ items });
  }

  // ---- section posts -------------------------------------------------------------
  // Reads only: posting/replying goes through the existing WS item.create entry
  // point (RoomDO.handleItemCreate), gated there by the channel/section kind
  // matrix - see room-do.ts.

  m = match("/api/stronghold/:id/rooms/:resId/posts", path);
  if (m && method === "GET") {
    const gate = await resolveGuestOrMember(request, env, m.id!);
    if (gate instanceof Response) return gate;
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return apiError(404, "NOT_FOUND");
    if (roomBlockedForGate(gate, room)) return apiError(404, "NOT_FOUND");
    if (room.type !== "section") return apiError(400, "ROOM_NOT_SECTION");

    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    const after = url.searchParams.get("after");
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    const requester = gate.kind === "member" ? gate.actor : null;
    return json(await roomStub.listPosts(after, limit, requester));
  }

  m = match("/api/stronghold/:id/rooms/:resId/posts/:seq", path);
  if (m && method === "GET") {
    const gate = await resolveGuestOrMember(request, env, m.id!);
    if (gate instanceof Response) return gate;
    const strongholdStub = env.STRONGHOLD_DO.getByName(m.id!);
    const room = await strongholdStub.getRoom(m.resId!);
    if (!room) return apiError(404, "NOT_FOUND");
    if (roomBlockedForGate(gate, room)) return apiError(404, "NOT_FOUND");
    if (room.type !== "section") return apiError(400, "ROOM_NOT_SECTION");
    const seq = Number(m.seq);
    if (!Number.isFinite(seq)) return apiError(400, "MALFORMED");

    const roomRef = `${m.id!}/${typeToKind(room.type)}/${m.resId!}`;
    const roomStub = env.ROOM_DO.getByName(roomRef);
    const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    const requester = gate.kind === "member" ? gate.actor : null;
    const result = await roomStub.getPost(seq, before, limit, requester);
    if (!result) return apiError(404, "NOT_FOUND");
    return json(result);
  }

  return errorResponse(404, "OMEW_NOT_FOUND", "no such route");
}

// ---- media upload pipeline --------------------------------------------------------
// Worker-proxied write straight into the R2 binding (no presigned direct-to-R2
// upload): size/MIME/quota are checked before a byte is written, then the body
// streams through a counting+hashing transform into R2 so nothing is buffered in
// full. Content-Length is trusted for the pre-checks but re-verified against the
// actual byte count as it streams; the declared MIME is re-verified against a
// magic-byte sniff of the received bytes once the stream ends.

const MEDIA_MIME_WHITELIST = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "audio/mpeg",
]);

const SANITIZED_IMAGE_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const MEDIA_SNIFF_BYTES = 16;

function sniffMediaMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "video/mp4";
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg"; // ID3-tagged
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return "audio/mpeg"; // frame sync, untagged
  }
  return null;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function mediaUsage(env: Env, actor: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM media WHERE owner_actor = ?")
    .bind(actor)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

async function deleteOwnedMediaReference(env: Env, actor: string, url: string | null | undefined, exceptId?: string): Promise<void> {
  const id = typeof url === "string" && url.startsWith("/media/") ? url.slice("/media/".length) : "";
  if (!id || id === exceptId) return;
  const row = await env.DB.prepare("SELECT r2_key FROM media WHERE id = ? AND owner_actor = ?").bind(id, actor).first<{ r2_key: string }>();
  if (!row) return;
  await env.MEDIA.delete(row.r2_key).catch(() => {});
  await env.DB.prepare("DELETE FROM media WHERE id = ? AND owner_actor = ?").bind(id, actor).run().catch(() => {});
}

async function readDeclaredUploadBody(body: ReadableStream<Uint8Array>, declaredLength: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > declaredLength) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return totalBytes === declaredLength ? concatBytes(chunks) : null;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) return null;
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) return null;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > bytes.length) return null;
      parts.push(bytes.subarray(offset - 2));
      return concatBytes(parts);
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(offset - 2, offset));
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) parts.push(bytes.subarray(offset - 2, end));
    offset = end;
  }
  return null;
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array | null {
  if (sniffMediaMime(bytes) !== "image/png") return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return null;
    const length = readU32BE(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    // Keep rendering chunks such as tRNS and animation controls. These are not
    // personal metadata and removing them changes the pixels users see.
    if (!["eXIf", "iTXt", "tEXt", "zTXt", "tIME", "pHYs", "iCCP"].includes(type)) parts.push(bytes.subarray(offset, end));
    if (bytes[offset + 4] === 0x49 && bytes[offset + 5] === 0x45 && bytes[offset + 6] === 0x4e && bytes[offset + 7] === 0x44) {
      return end === bytes.length ? concatBytes(parts) : null;
    }
    offset = end;
  }
  return null;
}

function stripWebpMetadata(bytes: Uint8Array): Uint8Array | null {
  if (sniffMediaMime(bytes) !== "image/webp" || bytes.length < 12) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 12)];
  let offset = 12;
  let removedFeatures = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null;
    const length = bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24);
    const end = offset + 8 + length + (length & 1);
    if (length < 0 || end > bytes.length) return null;
    const type = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    if (type === "EXIF") {
      removedFeatures |= 0x08;
    } else if (type === "XMP ") {
      removedFeatures |= 0x04;
    } else if (type === "ICCP") {
      removedFeatures |= 0x20;
    } else if (type === "VP8X" && length >= 1) {
      const vp8x = bytes.slice(offset, end);
      vp8x[8] = vp8x[8]! & ~removedFeatures;
      parts.push(vp8x);
    } else {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  const stripped = concatBytes(parts);
  // VP8X comes before optional chunks, so clear feature bits after all removals.
  if (removedFeatures !== 0) {
    for (let index = 12; index + 8 <= stripped.byteLength; ) {
      const length = stripped[index + 4]! | (stripped[index + 5]! << 8) | (stripped[index + 6]! << 16) | (stripped[index + 7]! << 24);
      if (String.fromCharCode(stripped[index]!, stripped[index + 1]!, stripped[index + 2]!, stripped[index + 3]!) === "VP8X" && length >= 1) {
        stripped[index + 8] = stripped[index + 8]! & ~removedFeatures;
        break;
      }
      index += 8 + length + (length & 1);
    }
  }
  writeU32LE(stripped, 4, stripped.byteLength - 8);
  return stripped;
}

function gifSubBlocksEnd(bytes: Uint8Array, offset: number): number {
  while (offset < bytes.byteLength) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    if (offset + length > bytes.byteLength) return -1;
    offset += length;
  }
  return -1;
}

function gifColorTableBytes(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1));
}

function stripGifMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 13 || (String.fromCharCode(...bytes.subarray(0, 6)) !== "GIF87a" && String.fromCharCode(...bytes.subarray(0, 6)) !== "GIF89a")) return null;
  let offset = 13 + gifColorTableBytes(bytes[10]!);
  if (offset > bytes.byteLength) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, offset)];
  while (offset < bytes.byteLength) {
    const start = offset;
    const introducer = bytes[offset++]!;
    if (introducer === 0x3b) return offset === bytes.byteLength ? concatBytes([...parts, bytes.subarray(start, offset)]) : null;
    if (introducer === 0x2c) {
      if (offset + 9 > bytes.byteLength) return null;
      const packed = bytes[offset + 8]!;
      offset += 9 + gifColorTableBytes(packed);
      if (offset >= bytes.byteLength) return null;
      const lzwMinimumCodeSize = bytes[offset++]!;
      if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) return null;
      const end = gifSubBlocksEnd(bytes, offset);
      if (end < 0) return null;
      parts.push(bytes.subarray(start, end));
      offset = end;
      continue;
    }
    if (introducer !== 0x21 || offset >= bytes.byteLength) return null;
    const label = bytes[offset++]!;
    if (label === 0xf9) {
      if (offset + 6 > bytes.byteLength || bytes[offset] !== 4 || bytes[offset + 5] !== 0) return null;
      offset += 6;
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    if (label === 0xff) {
      if (offset >= bytes.byteLength || bytes[offset] !== 11 || offset + 12 > bytes.byteLength) return null;
      const application = String.fromCharCode(...bytes.subarray(offset + 1, offset + 12));
      const end = gifSubBlocksEnd(bytes, offset + 12);
      if (end < 0) return null;
      if (application === "NETSCAPE2.0" || application === "ANIMEXTS1.0") parts.push(bytes.subarray(start, end));
      offset = end;
      continue;
    }
    if (label === 0xfe) {
      const end = gifSubBlocksEnd(bytes, offset);
      if (end < 0) return null;
      offset = end;
      continue;
    }
    if (label === 0x01) {
      if (offset >= bytes.byteLength || bytes[offset] !== 12 || offset + 13 > bytes.byteLength) return null;
      const end = gifSubBlocksEnd(bytes, offset + 13);
      if (end < 0) return null;
      offset = end;
      continue;
    }
    return null;
  }
  return null;
}

export function stripImageMetadata(bytes: Uint8Array, mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"): Uint8Array | null {
  if (mime === "image/jpeg") return stripJpegMetadata(bytes);
  if (mime === "image/png") return stripPngMetadata(bytes);
  if (mime === "image/webp") return stripWebpMetadata(bytes);
  return stripGifMetadata(bytes);
}

async function handleSanitizedImageUpload(
  request: Request,
  env: Env,
  actor: string,
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  declaredLength: number,
  maxFileBytes: number,
  storageQuotaBytes: number
): Promise<Response> {
  if (!request.body) return apiError(400, "PAYLOAD_INVALID");
  const input = await readDeclaredUploadBody(request.body, declaredLength);
  if (!input) return apiError(400, "LENGTH_MISMATCH");
  if (sniffMediaMime(input.subarray(0, MEDIA_SNIFF_BYTES)) !== mime) return apiError(415, "MIME_REJECTED");

  const sanitized = stripImageMetadata(input, mime);
  if (!sanitized) return apiError(415, "IMAGE_PROCESSING_FAILED");

  if (sanitized.byteLength === 0 || sniffMediaMime(sanitized.subarray(0, MEDIA_SNIFF_BYTES)) !== mime) {
    return apiError(415, "IMAGE_PROCESSING_FAILED");
  }
  if (sanitized.byteLength > maxFileBytes) return apiError(413, "FILE_TOO_LARGE");
  const used = await mediaUsage(env, actor);
  if (used + sanitized.byteLength > storageQuotaBytes) return apiError(413, "QUOTA_EXCEEDED");

  const id = crypto.randomUUID();
  const r2Key = `media/${id}`;
  const hash = createHash("sha256").update(sanitized).digest("hex");
  try {
    await env.MEDIA.put(r2Key, sanitized, { httpMetadata: { contentType: mime } });
  } catch {
    await env.MEDIA.delete(r2Key).catch(() => {});
    return apiError(400, "UPLOAD_FAILED");
  }

  try {
    await env.DB.prepare(
      "INSERT INTO media (id, hash, owner_actor, size, mime, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, hash, actor, sanitized.byteLength, mime, r2Key, Date.now())
      .run();
  } catch {
    await env.MEDIA.delete(r2Key).catch(() => {});
    return apiError(400, "UPLOAD_FAILED");
  }
  return json({ id, url: `/media/${id}`, size: sanitized.byteLength, mime }, 201);
}

async function handleMediaUpload(request: Request, env: Env): Promise<Response> {
  const actor = await requireActor(request, env);
  if (!actor) return apiError(401, "AUTH_REQUIRED");

  const contentTypeHeader = request.headers.get("Content-Type");
  const contentLengthHeader = request.headers.get("Content-Length");
  if (!contentTypeHeader || !contentLengthHeader) return apiError(400, "PAYLOAD_INVALID");
  const declaredLength = Number(contentLengthHeader);
  if (!Number.isInteger(declaredLength) || declaredLength <= 0) return apiError(400, "PAYLOAD_INVALID");
  const mime = contentTypeHeader.split(";")[0]!.trim().toLowerCase();

  const config = await getInstanceConfig(env);
  if (declaredLength > config.max_file_bytes) {
    await request.body?.cancel().catch(() => {});
    return apiError(413, "FILE_TOO_LARGE");
  }
  if (!MEDIA_MIME_WHITELIST.has(mime)) {
    await request.body?.cancel().catch(() => {});
    return apiError(415, "MIME_REJECTED");
  }
  if (SANITIZED_IMAGE_MIME_WHITELIST.has(mime)) {
    return handleSanitizedImageUpload(
      request,
      env,
      actor,
      mime as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
      declaredLength,
      config.max_file_bytes,
      config.user_storage_quota_bytes
    );
  }

  const used = await mediaUsage(env, actor);
  if (used + declaredLength > config.user_storage_quota_bytes) {
    await request.body?.cancel().catch(() => {});
    return apiError(413, "QUOTA_EXCEEDED");
  }

  if (!request.body) return apiError(400, "PAYLOAD_INVALID");

  const id = crypto.randomUUID();
  const r2Key = `media/${id}`;
  const hash = createHash("sha256");
  let totalBytes = 0;
  let forwardedBytes = 0;
  let sniffLen = 0;
  const sniffChunks: Uint8Array[] = [];

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      // Never error/cancel the inbound request stream on an overrun. Workerd
      // otherwise reports its internal request-body producer as an uncaught
      // client disconnect. Forward only the declared prefix into the fixed-size
      // R2 stream and keep draining the remainder; the object is deleted below.
      const remaining = declaredLength - forwardedBytes;
      if (remaining <= 0) return;
      const forwarded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      forwardedBytes += forwarded.byteLength;
      hash.update(forwarded);
      if (sniffLen < MEDIA_SNIFF_BYTES) {
        const prefix = forwarded.subarray(0, MEDIA_SNIFF_BYTES - sniffLen);
        sniffChunks.push(prefix);
        sniffLen += prefix.byteLength;
      }
      controller.enqueue(forwarded);
    },
  });

  // R2Bucket.put() only accepts a stream with a known length (a request/response
  // body, or the readable half of a FixedLengthStream) - a plain TransformStream's
  // output doesn't carry that metadata, so the counting/hashing transform feeds a
  // FixedLengthStream pinned to the declared length before reaching R2.
  const fixedLength = new FixedLengthStream(declaredLength);
  const pump = request.body
    .pipeThrough(counter)
    .pipeTo(fixedLength.writable)
    .catch(() => {});

  try {
    await env.MEDIA.put(r2Key, fixedLength.readable, { httpMetadata: { contentType: mime } });
  } catch {
    await pump;
    await env.MEDIA.delete(r2Key).catch(() => {});
    if (totalBytes !== declaredLength) return apiError(400, "LENGTH_MISMATCH");
    return apiError(400, "UPLOAD_FAILED");
  }
  await pump;

  if (totalBytes !== declaredLength) {
    await env.MEDIA.delete(r2Key).catch(() => {});
    return apiError(400, "LENGTH_MISMATCH");
  }

  const sniffed = sniffMediaMime(concatBytes(sniffChunks).subarray(0, MEDIA_SNIFF_BYTES));
  if (sniffed !== mime) {
    await env.MEDIA.delete(r2Key).catch(() => {});
    return apiError(415, "MIME_REJECTED");
  }

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO media (id, hash, owner_actor, size, mime, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, hash.digest("hex"), actor, totalBytes, mime, r2Key, now)
    .run();

  return json({ id, url: `/media/${id}`, size: totalBytes, mime }, 201);
}

// ---- emote pack helpers ------------------------------------------------------------
// Colon is the `:pack:name:` delimiter (web-side rendering, see 018 task notes), so
// pack/emote names exclude it; otherwise a name is just a non-empty string <= 32 chars.

function isValidEmoteName(name: string): boolean {
  return name.length > 0 && name.length <= 32 && !name.includes(":");
}

interface EmoteEntry {
  id: string;
  name: string;
  media_id: string;
  url: string;
}

async function listEmotePacks(env: Env): Promise<{ id: string; name: string; emotes: EmoteEntry[] }[]> {
  const { results: packRows } = await env.DB.prepare("SELECT id, name FROM emote_packs ORDER BY created_at ASC").all<{
    id: string;
    name: string;
  }>();
  const { results: emoteRows } = await env.DB.prepare(
    "SELECT id, pack_id, name, media_id FROM emotes ORDER BY created_at ASC"
  ).all<{ id: string; pack_id: string; name: string; media_id: string }>();

  const byPack = new Map<string, EmoteEntry[]>();
  for (const row of emoteRows) {
    const list = byPack.get(row.pack_id) ?? [];
    list.push({ id: row.id, name: row.name, media_id: row.media_id, url: `/media/${row.media_id}` });
    byPack.set(row.pack_id, list);
  }
  return packRows.map((pack) => ({ id: pack.id, name: pack.name, emotes: byPack.get(pack.id) ?? [] }));
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// Stronghold/room creation via /api/* doesn't take a client-supplied id/res_id
// (unlike the /stronghold/* dev-convenience routes) - generate one that always
// satisfies RES_ID_RE.
function generateResId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

// claims a globally-unique slug for a brand-new stronghold id.
// The D1 index table's PRIMARY KEY on slug does the actual race-safe claim -
// this just retries with a numeric suffix on conflict, same idiom as the rest
// of this codebase's conflict-then-retry writes (e.g. invite code generation).
const SLUG_CLAIM_MAX_ATTEMPTS = 50;

async function reserveSlug(env: Env, strongholdId: string, name: string): Promise<string> {
  const base = deriveSlugBase(name);
  let candidate = base;
  for (let attempt = 1; attempt <= SLUG_CLAIM_MAX_ATTEMPTS; attempt++) {
    try {
      await env.DB.prepare("INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)")
        .bind(candidate, strongholdId)
        .run();
      return candidate;
    } catch {
      candidate = `${base}-${attempt + 1}`;
    }
  }
  // Pathological collision storm - fall back to a slug nobody else can guess.
  const fallback = `${base}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  await env.DB.prepare("INSERT INTO stronghold_slug_index (slug, stronghold_id) VALUES (?, ?)").bind(fallback, strongholdId).run();
  return fallback;
}

// Shared by the open-policy path in POST /api/strongholds and by approving a
// stronghold_applications row - both end with the same owner + default rooms.
async function createStrongholdWithDefaults(
  env: Env,
  name: string,
  visibility: "public" | "private",
  ownerActor: string,
  description?: string
): Promise<ConfigRow> {
  const id = generateResId();
  const slug = await reserveSlug(env, id, name);
  const stub = env.STRONGHOLD_DO.getByName(id);
  const config = await stub.initConfig(id, name, visibility, ownerActor, description, undefined, slug);
  // Every stronghold starts with one real channel and one real section - tips
  // and room lookups work immediately, no separate "register this room" step.
  await stub.createRoom("lobby", "channel", "大厅", ["text"], false);
  await stub.createRoom("posts", "section", "帖子", ["text"], false);
  return config;
}

// ---- stronghold settings & member management helpers -----------------------------

// DO storage keeps allow_message_edit/allow_message_retract as 0/1 (SqlStorageValue
// convention, matches restricted/archived elsewhere in this codebase) - coerce to
// real JSON booleans at the wire boundary, same pattern as users.ts's toPublicUser.
function toApiConfig(row: ConfigRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cover: row.cover,
    avatar: row.avatar,
    visibility: row.visibility,
    icon: row.icon,
    allow_message_edit: Boolean(row.allow_message_edit),
    allow_message_retract: Boolean(row.allow_message_retract),
    edit_window_secs: row.edit_window_secs,
    owner_actor: row.owner_actor,
    created_at: row.created_at,
    slug: row.slug,
  };
}

function toApiRoom(row: RoomRow, postCount?: number) {
  // m0-protocol §3.2a/§13.3: reactions are served on every room regardless of
  // when it was created, so rooms whose stored capabilities predate the feature
  // get it unioned in rather than misreporting themselves.
  const caps = JSON.parse(row.capabilities_json) as string[];
  return {
    id: row.res_id,
    name: row.name,
    type: row.type,
    description: row.description,
    capabilities: caps.includes("reactions") ? caps : [...caps, "reactions"],
    ...(postCount != null ? { post_count: postCount } : {}),
  };
}

// PATCH /api/admin/strongholds/:id/slug format gate.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ---- server groups helpers (m0-protocol §7.10a) ------------------------

interface ServerGroupRow {
  id: string;
  name: string;
  color: string | null;
  position: number;
  allow_speak: number;
  allow_post: number;
  allow_reply: number;
  is_moderator: number;
  created_at: number;
}

function toApiGroup(row: ServerGroupRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    allow_speak: row.allow_speak,
    allow_post: row.allow_post,
    allow_reply: row.allow_reply,
    is_moderator: Boolean(row.is_moderator),
  };
}

function isValidGroupName(name: string): boolean {
  return name.length > 0 && name.length <= 32;
}

const INVALID_COLOR = Symbol("invalid_color");
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Optional hex color - absent/null clears it, anything else must match #RRGGBB.
function parseOptionalColor(v: unknown): string | null | typeof INVALID_COLOR {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !COLOR_RE.test(v)) return INVALID_COLOR;
  return v;
}

// Room description - trimmed, <=64 chars, absent/null/empty clears it.
const INVALID_DESCRIPTION = Symbol("invalid_description");
const DESCRIPTION_MAX = 64;

function asOptionalDescription(v: unknown): string | null | typeof INVALID_DESCRIPTION {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return INVALID_DESCRIPTION;
  const trimmed = v.trim();
  if (trimmed.length > DESCRIPTION_MAX) return INVALID_DESCRIPTION;
  return trimmed || null;
}

// perm_speak/perm_post/perm_reply: -1 deny / 0 inherit / 1 allow. Missing means
// "leave at inherit" on create, invalid on anything else.
function parseTriState(v: unknown): -1 | 0 | 1 | null {
  if (v === undefined) return 0;
  if (v === -1 || v === 0 || v === 1) return v;
  return null;
}

const ROOM_ERROR_STATUS: Record<string, number> = {
  OMEW_MALFORMED: 400,
  OMEW_TARGET_NOT_FOUND: 404,
  OMEW_ITEM_DELETED: 409,
  OMEW_FORBIDDEN: 403,
  EDIT_DISABLED: 403,
  RETRACT_DISABLED: 403,
  WINDOW_EXPIRED: 403,
};

function roomErrorStatus(code: string): number {
  return ROOM_ERROR_STATUS[code] ?? 400;
}

interface ActorProfile {
  display_name: string;
  avatar: string | null;
  last_active_at: number | null;
  is_guest: boolean;
  home_domain?: string;
}

// Batch actor -> profile lookup, split across the local `users` table and the
// `guest_identity` table per m0-protocol §7.2's authority split (registration
// instance owns the profile; a member row here only owns role/deny/joined_at).
async function actorProfiles(env: Env, actors: string[]): Promise<Map<string, ActorProfile>> {
  const result = new Map<string, ActorProfile>();
  const unique = [...new Set(actors)];
  const home = instanceDomain(env);
  const localActors = unique.filter((a) => domainOfActor(a) === home);
  const guestActors = unique.filter((a) => domainOfActor(a) !== home);

  if (localActors.length > 0) {
    const localparts = localActors.map(localpartOfActor);
    const placeholders = localparts.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT localpart, display_name, avatar, last_active_at FROM users WHERE localpart IN (${placeholders})`
    )
      .bind(...localparts)
    .all<{ localpart: string; display_name: string; avatar: string | null; last_active_at: number | null }>();
    const byLocalpart = new Map(results.map((r) => [r.localpart, r]));
    for (const actor of localActors) {
      const localpart = localpartOfActor(actor);
      const row = byLocalpart.get(localpart);
      result.set(actor, { display_name: row?.display_name ?? localpart, avatar: row?.avatar ?? null, last_active_at: row?.last_active_at ?? null, is_guest: false });
    }
  }

  if (guestActors.length > 0) {
    const placeholders = guestActors.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT actor, display_name, avatar, registered_origin FROM guest_identity WHERE actor IN (${placeholders})`
    )
      .bind(...guestActors)
      .all<{ actor: string; display_name: string | null; avatar: string | null; registered_origin: string }>();
    const byActor = new Map(results.map((r) => [r.actor, r]));
    for (const actor of guestActors) {
      const row = byActor.get(actor);
      result.set(actor, { display_name: row?.display_name ?? actor, avatar: row?.avatar ?? null, last_active_at: null, is_guest: true, home_domain: row?.registered_origin });
    }
  }

  return result;
}

// Group membership is no longer sourced here (server groups are
// server-wide, not per-stronghold) - the web client fetches it separately
// from GET /api/server-groups/members.
function toMemberEntry(member: MemberRow, profile: ActorProfile | undefined) {
  return {
    actor: member.actor,
    display_name: profile?.display_name ?? member.actor,
    avatar: profile?.avatar ?? null,
    last_active_at: profile?.last_active_at ?? null,
    role: member.role,
    deny: member.deny,
    joined_at: member.joined_at,
    is_guest: profile?.is_guest ?? false,
    ...(profile?.home_domain ? { home_domain: profile.home_domain } : {}),
  };
}

const MEMBERS_PAGE_SIZE = 50;

function paginateMembers(members: MemberRow[], afterCursor: string | null): { page: MemberRow[]; next_cursor: string | null } {
  const sorted = [...members].sort((a, b) => a.joined_at - b.joined_at || a.actor.localeCompare(b.actor));
  let startIndex = 0;
  if (afterCursor) {
    const idx = sorted.findIndex((entry) => entry.actor === afterCursor);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }
  const page = sorted.slice(startIndex, startIndex + MEMBERS_PAGE_SIZE);
  const hasMore = startIndex + MEMBERS_PAGE_SIZE < sorted.length;
  const last = page[page.length - 1];
  return { page, next_cursor: hasMore && last ? last.actor : null };
}

async function issueSessionToken(actor: string, serverRole: ServerRole, env: Env): Promise<string> {
  const claims: SessionTokenClaims = {
    v: 1, typ: "session", actor, server_role: serverRole, exp: nowS() + SESSION_TOKEN_TTL_S, jti: newJti(),
  };
  return signToken(claims, env.DEV_TOKEN_SECRET);
}

async function requireMembership(request: Request, env: Env, strongholdId: string): Promise<Response | null> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return errorResponse(401, "OMEW_SESSION_INVALID", "auth required");
  const stub = env.STRONGHOLD_DO.getByName(strongholdId);
  const member = await stub.getMember(session.actor);
  if (!overlayRole(session.server_role, member)) return errorResponse(403, "OMEW_BANNED", "not a member or banned");
  return null;
}

// S9: read paths carry the same role check as write paths - GET endpoints MUST
// also be clipped by role, not just POST/PATCH/DELETE. Role here is
// the group-synthesized effective role (effectiveRole), not the raw member row.
async function requireRole(request: Request, env: Env, strongholdId: string, roles: Role[]): Promise<Response | { actor: string; role: Role }> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return errorResponse(401, "OMEW_SESSION_INVALID", "auth required");
  const eff = await effectiveRole(env, strongholdId, session.server_role, session.actor);
  if (!eff) return errorResponse(403, "OMEW_BANNED", "not a member or banned");
  if (!roles.includes(eff.role)) return errorResponse(403, "OMEW_FORBIDDEN", "insufficient role");
  return { actor: session.actor, role: eff.role };
}

// ---- guest read gate (m0-protocol §8.2) -------------------------------
// A public stronghold MAY serve guest reads when allow_guest_browsing is on.
// Authenticated non-members use that same read-only gate; banned members remain
// blocked, and private/write routes keep their membership requirements. A
// server_owner/server_admin still resolves to "member" through the §7.10 overlay.
async function resolveGuestOrMember(
  request: Request,
  env: Env,
  strongholdId: string
): Promise<
  | { kind: "member"; actor: string; member: MemberRow | null; role: Role; config: ConfigRow }
  | { kind: "guest"; config: ConfigRow }
  | Response
> {
  const stub = env.STRONGHOLD_DO.getByName(strongholdId);
  const config = await stub.getConfig();
  if (!config) return apiError(404, "NOT_FOUND");

  const session = await requireSession(request, env);
  if (!(session instanceof Response)) {
    const member = await stub.getMember(session.actor);
    const eff = await effectiveRole(env, strongholdId, session.server_role, session.actor);
    if (eff) return { kind: "member", actor: session.actor, member, role: eff.role, config };
    if (member) return apiError(403, "FORBIDDEN");

    // A registered account may browse public strongholds before joining one.
    // Treat it exactly like a guest for read routes, while all write and WS
    // token routes continue to use effectiveRole and still reject it.
    const policy = await getInstanceConfig(env);
    if (policy.allow_guest_browsing && config.visibility === "public") {
      return { kind: "guest", config };
    }
    return apiError(403, "FORBIDDEN");
  }

  const policy = await getInstanceConfig(env);
  if (policy.allow_guest_browsing && config.visibility === "public") {
    return { kind: "guest", config };
  }
  return apiError(401, "AUTH_REQUIRED");
}

function roomBlockedForGate(
  gate: { kind: "member"; role: Role } | { kind: "guest" },
  room: { restricted: number }
): boolean {
  return !canAccessRestrictedRoom(gate.kind === "member" ? gate.role : null, room);
}

// Public stronghold directory. The D1 read model is maintained by StrongholdDO
// write paths. Pre-projection strongholds are hydrated once by slug index; later
// reads remain one D1 query and never fan out per card.
async function listPublicDirectory(
  env: Env,
  onlyStrongholdId?: string,
): Promise<Array<{ id: string; name: string; description: string | null; avatar: string | null; cover: string | null; member_count: number; slug: string }>> {
  const { results: missing } = await env.DB.prepare(
    "SELECT stronghold_id FROM stronghold_slug_index EXCEPT SELECT stronghold_id FROM stronghold_directory_index"
  ).all<{
    stronghold_id: string;
  }>();
  await Promise.all(
    missing.map((row) => env.STRONGHOLD_DO.getByName(row.stronghold_id).hydrateDirectoryIndex())
  );
  const { results } = await env.DB.prepare(
    "SELECT directory.stronghold_id AS id, directory.name, directory.description, directory.avatar, directory.cover, " +
    "directory.member_count, directory.slug FROM stronghold_directory_index AS directory " +
    "INNER JOIN stronghold_slug_index AS slugs ON slugs.stronghold_id = directory.stronghold_id " +
    "WHERE directory.visibility = 'public' ORDER BY directory.name COLLATE NOCASE, directory.stronghold_id"
  ).all<{ id: string; name: string; description: string | null; avatar: string | null; cover: string | null; member_count: number; slug: string }>();
  return onlyStrongholdId ? results.filter((entry) => entry.id === onlyStrongholdId) : results;
}
