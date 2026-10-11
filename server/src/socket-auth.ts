import { getInstanceConfig } from "./config";
import { hasVerifiedAccountEmail, issuanceRevoked } from "./account-recovery";
import { validGuestSession } from "./federation";
import { instanceDomain, type SessionTokenClaims } from "./types";
import { domainOfActor, localpartOfActor } from "./users";

export async function socketActorIsActive(
  env: Env,
  claims: { actor: string; iat?: number; guest_session_jti?: string },
): Promise<boolean> {
  if (domainOfActor(claims.actor) !== instanceDomain(env)) {
    if (!claims.guest_session_jti) return false;
    return validGuestSession(env, {
      v: 1,
      typ: "session",
      actor: claims.actor,
      server_role: "user",
      auth_source: "federation",
      jti: claims.guest_session_jti,
      exp: Math.floor(Date.now() / 1000) + 1,
    } satisfies SessionTokenClaims);
  }
  const row = await env.DB.prepare(
    "SELECT status,sessions_revoked_at FROM users WHERE localpart=?",
  )
    .bind(localpartOfActor(claims.actor))
    .first<{ status: string; sessions_revoked_at: number | null }>();
  if (
    !row ||
    row.status !== "active" ||
    issuanceRevoked(claims.iat, row.sessions_revoked_at)
  )
    return false;
  return (
    !getInstanceConfig(env).root_requirements.includes("email") ||
    hasVerifiedAccountEmail(env, localpartOfActor(claims.actor))
  );
}
