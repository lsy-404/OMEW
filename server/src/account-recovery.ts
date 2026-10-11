type AccountAction = "email_verification" | "password_reset";

export type AccountRecoveryEnv = Pick<
  Env,
  "DB" | "DEV_TOKEN_SECRET" | "EMAIL" | "EMAIL_FROM" | "EMAIL_FROM_NAME" |
    "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY" | "TURNSTILE_ALLOWED_HOSTNAMES"
>;

export interface ThresholdSample {
  source: string;
  value: number;
  threshold: number;
}

export interface ThresholdEvent {
  event: "operations.threshold_exceeded";
  source: string;
  value: number;
  threshold: number;
}

export function evaluateThreshold(sample: ThresholdSample): ThresholdEvent | null {
  if (!sample.source || !Number.isFinite(sample.value) || !Number.isFinite(sample.threshold)) return null;
  if (sample.value < sample.threshold) return null;
  return {
    event: "operations.threshold_exceeded",
    source: sample.source,
    value: sample.value,
    threshold: sample.threshold,
  };
}

export function logOperationalEvent<T extends object>(event: T): void {
  console.log({ service: "openmew-server", ...event });
}

export function reportThreshold(sample: ThresholdSample): ThresholdEvent | null {
  const event = evaluateThreshold(sample);
  if (event) logOperationalEvent(event);
  return event;
}

export async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashIdentifier(identifier: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(identifier));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createOpaqueToken(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  hostname: string,
  action: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token || token.length > 2048 || !secret || !hostname || !action) return false;
  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
    return result.success === true && result.hostname === hostname && result.action === action;
  } catch {
    return false;
  }
}

export function turnstileEnabled(env: AccountRecoveryEnv): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.TURNSTILE_SITE_KEY?.trim());
}

export async function requireTurnstile(
  env: AccountRecoveryEnv,
  token: unknown,
  hostname: string,
  action: string,
): Promise<boolean> {
  const hasSiteKey = Boolean(env.TURNSTILE_SITE_KEY?.trim());
  const hasSecret = Boolean(env.TURNSTILE_SECRET_KEY?.trim());
  if (!hasSiteKey && !hasSecret) return true;
  if (!hasSiteKey || !hasSecret) {
    logOperationalEvent({ event: "account.turnstile_misconfigured" });
    return false;
  }
  const expectedHostnames = env.TURNSTILE_ALLOWED_HOSTNAMES?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalizedHostname = hostname.toLowerCase();
  if (expectedHostnames?.length && !expectedHostnames.includes(normalizedHostname)) return false;
  if (typeof token !== "string") return false;
  return verifyTurnstile(token, env.TURNSTILE_SECRET_KEY!, normalizedHostname, action);
}

export function emailSendingConfigured(env: AccountRecoveryEnv): boolean {
  return Boolean(env.EMAIL && env.EMAIL_FROM?.trim());
}

function actionLink(origin: string, action: AccountAction, token: string): string {
  const params = new URLSearchParams({ account_action: action, token });
  return `${origin.replace(/\/$/, "")}/#${params.toString()}`;
}

export async function sendAccountActionEmail(
  env: AccountRecoveryEnv,
  options: { action: AccountAction; localpart: string | null; email: string; origin: string; now?: number },
): Promise<void> {
  if (!emailSendingConfigured(env)) {
    logOperationalEvent({ event: "account.email_send_failed", action: options.action, reason: "configuration_missing" });
    throw new Error("ACCOUNT_EMAIL_NOT_CONFIGURED");
  }
  const now = options.now ?? Date.now();
  const token = createOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = now + (options.action === "password_reset" ? 15 : 60) * 60 * 1000;
  await env.DB.prepare(
    "DELETE FROM account_action_tokens WHERE expires_at <= ?",
  ).bind(now).run();
  await env.DB.prepare(
    "DELETE FROM account_action_tokens WHERE action = ? AND ((localpart IS NOT NULL AND localpart = ?) OR email = ?)",
  ).bind(options.action, options.localpart, options.email.toLowerCase()).run();
  if (options.localpart !== null) {
    await env.DB.prepare(
      "INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(tokenHash, options.action, options.localpart, options.email.toLowerCase(), now, expiresAt).run();
  }

  const link = actionLink(options.origin, options.action, token);
  const verification = options.action === "email_verification";
  const subject = verification ? "Verify your OMEW email" : "Reset your OMEW password";
  const instruction = verification
    ? "Open this one-time link to verify the email address on your OMEW account."
    : "If this address is linked to an OMEW account with a verified email, open this one-time link to reset its password.";
  try {
    await env.EMAIL!.send({
      to: options.email,
      from: { email: env.EMAIL_FROM!.trim(), name: env.EMAIL_FROM_NAME?.trim() || "OMEW" },
      subject,
      text: `${instruction}\n\n${link}\n\nThis link expires in ${verification ? "60 minutes" : "15 minutes"}.`,
      html: `<p>${instruction}</p><p><a href="${link}">${verification ? "Verify email" : "Reset password"}</a></p><p>This link expires in ${verification ? "60 minutes" : "15 minutes"}.</p>`,
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM account_action_tokens WHERE token_hash = ?").bind(tokenHash).run();
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "send_failed";
    logOperationalEvent({ event: "account.email_send_failed", action: options.action, code });
    throw new Error("ACCOUNT_EMAIL_SEND_FAILED");
  }
  logOperationalEvent({ event: "account.email_sent", action: options.action });
}

export async function requestRateLimited(
  env: AccountRecoveryEnv,
  action: AccountAction,
  identifiers: string[],
  now = Date.now(),
): Promise<boolean> {
  const hashes = await Promise.all(identifiers.filter(Boolean).map((identifier) => hashIdentifier(identifier, env.DEV_TOKEN_SECRET)));
  const windowMs = 60 * 60 * 1000;
  const maximum = action === "password_reset" ? 3 : 4;
  await env.DB.prepare("DELETE FROM account_action_limits WHERE window_start <= ?").bind(now - 24 * windowMs).run();
  for (const identityHash of hashes) {
    await env.DB.prepare(
      `INSERT INTO account_action_limits (action, identity_hash, window_start, request_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(action, identity_hash) DO UPDATE SET
         request_count = CASE WHEN window_start <= ? THEN 1 ELSE request_count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END`,
    ).bind(action, identityHash, now, now - windowMs, now - windowMs).run();
    const row = await env.DB.prepare(
      "SELECT request_count FROM account_action_limits WHERE action = ? AND identity_hash = ?",
    ).bind(action, identityHash).first<{ request_count: number }>();
    if ((row?.request_count ?? 0) > maximum) return true;
  }
  return false;
}

export async function consumeActionToken(
  env: AccountRecoveryEnv,
  action: AccountAction,
  rawToken: string,
  now = Date.now(),
): Promise<{ localpart: string | null; email: string } | null> {
  if (rawToken.length < 32 || rawToken.length > 128) return null;
  const tokenHash = await hashOpaqueToken(rawToken);
  const row = await env.DB.prepare(
    "SELECT localpart, email FROM account_action_tokens WHERE token_hash = ? AND action = ? AND expires_at > ?",
  ).bind(tokenHash, action, now).first<{ localpart: string | null; email: string }>();
  if (!row) return null;
  const deleted = await env.DB.prepare(
    "DELETE FROM account_action_tokens WHERE token_hash = ? AND action = ? AND expires_at > ?",
  ).bind(tokenHash, action, now).run();
  return deleted.meta.changes === 1 ? row : null;
}
