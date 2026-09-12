// Username/email validation and invite-code helpers for the real user system
// that replaces the M1 dev-token stub. HMAC session tokens themselves are
// unchanged - see auth.ts. Instance policy parsing lives in config.ts.

import { base64UrlEncode } from "./auth";
import type { InstanceConfig, PublicUser, ServerRole } from "./types";

// m0-protocol §1.3 calls for PRECIS UsernameCaseMapped; this is an approximation
// (case-fold to lowercase, then restrict to the wire ASCII subset). Full PRECIS /
// UTS #39 confusable handling (§1.4) is out of scope for M1.
const USERNAME_RE = /^[a-z0-9_-]{2,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INVITE_CODE_BYTES = 15; // -> 20 base64url chars, ~120 bits

export function normalizeUsername(input: string): string {
  return input.toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function generateInviteCode(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(INVITE_CODE_BYTES)));
}

// Local actors are always `@localpart:HOME_DOMAIN` (types.ts) - recover the
// localpart to look a session's actor up in the users table.
export function localpartOfActor(actor: string): string {
  const colon = actor.indexOf(":");
  return actor.startsWith("@") && colon > 1 ? actor.slice(1, colon) : "";
}

// The domain half of `@localpart:domain` - distinguishes a local user (domain ==
// HOME_DOMAIN, looked up in `users`) from a guest actor (looked up in `guest_identity`).
export function domainOfActor(actor: string): string {
  const colon = actor.indexOf(":");
  return actor.startsWith("@") && colon > 1 ? actor.slice(colon + 1) : "";
}

export function isOriginTrusted(config: InstanceConfig, origin: string): boolean {
  return config.trusted_identity_servers.includes("*") || config.trusted_identity_servers.includes(origin);
}

// is_admin is kept for client compatibility (types.ts's PublicUser doc) but is
// derived, not read off a DB column - the users.is_admin column stopped being
// read entirely once server_role (migration 0008) took over (m0-protocol §7.10).
export function toPublicUser(
  row: {
    localpart: string;
    username?: string | null;
    display_name?: string | null;
    avatar?: string | null;
    cover?: string | null;
    bio?: string | null;
    server_role: ServerRole;
    email: string | null;
    email_verified: number;
    totp_enabled?: number;
  },
  actor: string
): PublicUser {
  return {
    username: row.username || row.localpart,
    // rows predating the display-name column, and the registration path (which
    // writes the localpart as the initial display name), both fall back to it.
    display_name: row.display_name || row.localpart,
    avatar: row.avatar ?? null,
    cover: row.cover ?? null,
    bio: row.bio ?? null,
    actor,
    server_role: row.server_role,
    is_admin: row.server_role === "owner" || row.server_role === "admin",
    email: row.email,
    email_verified: Boolean(row.email_verified),
    totp_enabled: row.totp_enabled === 1,
  };
}
