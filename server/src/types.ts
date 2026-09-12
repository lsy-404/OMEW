// `Env` itself is not declared here - it comes from wrangler-generated
// worker-configuration.d.ts (run `npm run types` in server/ after touching
// wrangler.jsonc) plus the DEV_TOKEN_SECRET augmentation in src/env.d.ts.

// Placeholder for this instance's own domain when no public deployment host is
// available, used by local development and tests.
export const HOME_DOMAIN = "local";

// An explicit deployment domain always wins. Without one, only a genuine
// workers.dev request host is accepted as public instance identity; arbitrary
// Host values must not turn local/test instances into public identities.
export function instanceDomain(env: Env, requestHostname?: string): string {
  if (env.INSTANCE_DOMAIN) return env.INSTANCE_DOMAIN;
  const hostname = requestHostname?.toLowerCase();
  return hostname && hostname.endsWith(".workers.dev") && hostname !== "workers.dev"
    ? hostname
    : HOME_DOMAIN;
}

// Route-level helpers share the resolved identity through the existing Env
// parameter without mutating a deployment's bindings or global environment.
export function withRequestInstanceDomain(env: Env, requestHostname: string): Env {
  if (env.INSTANCE_DOMAIN) return env;
  return Object.assign(Object.create(env), {
    INSTANCE_DOMAIN: instanceDomain(env, requestHostname),
  }) as Env;
}

// m0-protocol S3.4 deny bitmask.
export const DENY_CHANNEL_SPEAK = 1;
export const DENY_SECTION_POST = 2;
export const DENY_SECTION_REPLY = 4;

export type Role = "owner" | "mod" | "member";

export type RoomKind = "ch" | "sec";
// m0-protocol S3.6: `type` uses full words in stronghold.room.create payloads;
// S1.5 room-ref path segments use the "ch"/"sec" abbreviation. Two vocabularies,
// same concept - convert at the boundary rather than storing both.
export type RoomType = "channel" | "section";

export function typeToKind(type: RoomType): RoomKind {
  return type === "channel" ? "ch" : "sec";
}

// m0-protocol S9 / S7.3: room-scoped WS token claims.
export interface RoomTokenClaims {
  v: 1;
  typ: "room";
  actor: string;
  room: string; // room-ref
  role: Role;
  deny: number;
  exp: number; // unix seconds, MUST <= now + 300
  jti: string;
}

// m0-protocol S7.3: stronghold-scoped WS token claims (tips channel), grants no write access.
export interface StrongholdTokenClaims {
  v: 1;
  typ: "stronghold";
  actor: string;
  stronghold: string;
  role: Role;
  exp: number;
  jti: string;
}

// m0-protocol §7.10: server-level role tier, orthogonal to stronghold roles.
// server_owner is unique (the instance operator); server_admin is appointable
// by server_owner. Neither propagates over federation.
export type ServerRole = "owner" | "admin" | "user";
export type AuthSource = "local" | "sso";
export type SsoMode = "disabled" | "optional" | "required";
export type InstanceMode = "multi" | "single";

// Session claims (see auth.ts for the HMAC signing mechanism) - not a WS token,
// used for HTTP bearer auth. Issued by /api/register and /api/login (users.ts).
// Carries the role observed at issuance for client display/debugging. The API
// re-resolves local users' current role from D1 before every authorization
// decision, so a demotion takes effect immediately.
export interface SessionTokenClaims {
  v: 1;
  typ: "session";
  actor: string;
  server_role: ServerRole;
  auth_source: AuthSource;
  exp: number;
  jti: string;
}

// m0-protocol §7.2a: TOTP second factor and WebAuthn passkey short-lived
// tokens, same signed-compact-token mechanism as SessionTokenClaims - the
// `typ` discriminant is what makes requireSession's `claims.typ !== "session"`
// check reject all three by construction, no extra guard code needed.
export interface TotpPendingTokenClaims {
  v: 1;
  typ: "totp_pending";
  actor: string;
  exp: number;
  jti: string;
}

export interface WebauthnRegChallengeClaims {
  v: 1;
  typ: "webauthn_reg";
  actor: string;
  challenge: string;
  exp: number;
  jti: string;
}

export interface WebauthnAuthChallengeClaims {
  v: 1;
  typ: "webauthn_auth";
  challenge: string;
  exp: number;
  jti: string;
}

// Instance-level identity/governance policy (m0-protocol §7.9) - deployment env
// config (server/src/config.ts), not runtime-writable.
export type RootRequirement = "email" | "phone" | "code";

// m0-protocol §7.9: self-operated instance governance policies.
export type StrongholdCreationPolicy = "open" | "restricted" | "application";

export interface RootStronghold {
  id: string;
  name: string;
  slug: string;
}

export interface InstanceConfig {
  instance_mode: InstanceMode;
  root_stronghold: string | null;
  allow_root: boolean;
  root_requirements: RootRequirement[];
  trusted_identity_servers: string[];
  max_file_bytes: number;
  user_storage_quota_bytes: number;
  // Outbound content-federation allowlist (migration 0006), independent of
  // trusted_identity_servers (identity admission). Subscribe/backfill wiring
  // lands in M5/M6 and MUST target only this list (m0-protocol §7.9).
  federation_peers: string[];
  stronghold_creation_policy: StrongholdCreationPolicy;
  stronghold_creators: string[];
  // Unauthenticated read-only access to public strongholds (m0-protocol
  // §8.2's "public visibility MAY serve unauthenticated reads"), gated by this
  // local policy toggle on top of the protocol's MAY. Migration 0007, default on.
  allow_guest_browsing: boolean;
}

// Shape returned to clients on register/login - never includes pw_hash/pw_salt or
// the ownership ciphertext. is_admin is kept for client compatibility: true
// whenever server_role is "owner" or "admin" (§7.10) - the DB column it used to
// read no longer exists as a source of truth, see users.ts's toPublicUser.
export interface PublicUser {
  username: string;
  display_name: string;
  avatar: string | null;
  cover: string | null;
  bio: string | null;
  actor: string;
  server_role: ServerRole;
  is_admin: boolean;
  email: string | null;
  email_verified: boolean;
  totp_enabled: boolean;
}
