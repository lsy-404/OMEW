import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { apiRequest, ensureMigrated, loginAs, registerUser } from "./helpers";
import { evaluateThreshold, hashOpaqueToken, issuanceRevoked, verifyTurnstile } from "../server/src/account-recovery";
import recoveryMigration from "../server/migrations/0027_account_recovery.sql?raw";

beforeAll(async () => {
  await ensureMigrated();
  const columns = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  const hasRevocationTime = columns.results.some((column) => column.name === "sessions_revoked_at");
  if (!hasRevocationTime) {
    for (const statement of recoveryMigration.split(";").map((part) => part.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
  }
});

describe("opaque recovery token handling", () => {
  it("stores only a stable SHA-256 digest, never the bearer token", async () => {
    const token = "a-single-use-secret-token";
    const digest = await hashOpaqueToken(token);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
    expect(await hashOpaqueToken(token)).toBe(digest);
  });
});

describe("session issuance revocation", () => {
  it("rejects tokens issued before the account revocation time, including legacy tokens without iat", () => {
    expect(issuanceRevoked(100, 101)).toBe(true);
    expect(issuanceRevoked(undefined, 101)).toBe(true);
    expect(issuanceRevoked(102, 101)).toBe(false);
    expect(issuanceRevoked(undefined, null)).toBe(false);
  });
});

describe("Turnstile server verification", () => {
  it("requires success plus the expected deployment hostname and action", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: "omew.example",
      action: "register",
    }), { headers: { "content-type": "application/json" } }));

    await expect(verifyTurnstile("token-value", "secret-value", "omew.example", "register", fetcher))
      .resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a valid token issued for another action or hostname", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: "attacker.example",
      action: "password-reset",
    })));

    await expect(verifyTurnstile("token-value", "secret-value", "omew.example", "register", fetcher))
      .resolves.toBe(false);
  });
});

describe("capacity and dead-letter threshold evaluation", () => {
  it("emits an alert only when a real measurement meets its configured threshold", () => {
    expect(evaluateThreshold({ source: "queue.dlq", value: 0, threshold: 1 })).toBeNull();
    expect(evaluateThreshold({ source: "queue.dlq", value: 3, threshold: 1 })).toEqual({
      event: "operations.threshold_exceeded",
      source: "queue.dlq",
      value: 3,
      threshold: 1,
    });
  });

  it("ignores invalid or absent measurements instead of inventing an alert", () => {
    expect(evaluateThreshold({ source: "d1.capacity", value: Number.NaN, threshold: 0.9 })).toBeNull();
    expect(evaluateThreshold({ source: "d1.capacity", value: 0.8, threshold: 0.9 })).toBeNull();
  });
});

describe("password recovery", () => {
  it("consumes the reset token once, changes the password, and revokes prior sessions", async () => {
    const username = "recoverycontract";
    const initialPassword = "initial-password-123";
    const { status, json } = await registerUser({
      username,
      password: initialPassword,
      ownership_pubkey: "recovery-test-key",
      ownership_ciphertext: "recovery-test-envelope",
    });
    expect(status).toBe(200);
    const oldToken = json.token as string;

    await env.DB.prepare("UPDATE users SET email = ?, email_verified = 1 WHERE localpart = ?")
      .bind("recovery-contract@example.com", username).run();
    const resetToken = "single-use-password-reset-token-value-2026";
    const tokenHash = await hashOpaqueToken(resetToken);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at) VALUES (?, 'password_reset', ?, ?, ?, ?)",
    ).bind(tokenHash, username, "recovery-contract@example.com", now, now + 60_000).run();

    const response = await apiRequest("/api/account/password-reset/complete", {
      method: "POST",
      body: JSON.stringify({ token: resetToken, new_password: "recovered-password-456" }),
    });
    expect(response.status).toBe(204);

    const oldSession = await apiRequest("/api/me/ownership", { headers: { Authorization: `Bearer ${oldToken}` } });
    expect(oldSession.status).toBe(401);
    const replay = await apiRequest("/api/account/password-reset/complete", {
      method: "POST",
      body: JSON.stringify({ token: resetToken, new_password: "another-password-789" }),
    });
    expect(replay.status).toBe(400);
    const oldPassword = await apiRequest("/api/login", {
      method: "POST", body: JSON.stringify({ username, password: initialPassword }),
    });
    expect(oldPassword.status).toBe(401);
    const newPassword = await apiRequest("/api/login", {
      method: "POST", body: JSON.stringify({ username, password: "recovered-password-456" }),
    });
    expect(newPassword.status).toBe(200);
    expect(await loginAs(username, "recovered-password-456")).toBeTruthy();
  });

  it("rejects an expired token without changing the existing password", async () => {
    const username = "recoveryexpired";
    const password = "still-valid-password-123";
    const { json } = await registerUser({
      username,
      password,
      ownership_pubkey: "recovery-expired-key",
      ownership_ciphertext: "recovery-expired-envelope",
    });
    await env.DB.prepare("UPDATE users SET email = ?, email_verified = 1 WHERE localpart = ?")
      .bind("recovery-expired@example.com", username).run();
    const token = "expired-password-reset-token-value-2026";
    const tokenHash = await hashOpaqueToken(token);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at) VALUES (?, 'password_reset', ?, ?, ?, ?)",
    ).bind(tokenHash, username, "recovery-expired@example.com", now - 60_000, now - 1).run();

    const expired = await apiRequest("/api/account/password-reset/complete", {
      method: "POST", body: JSON.stringify({ token, new_password: "rejected-password-456" }),
    });
    expect(expired.status).toBe(400);
    const stillValid = await apiRequest("/api/login", {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    expect(stillValid.status).toBe(200);
  });

  it("keeps the one-time token usable when the password update transaction fails", async () => {
    const username = "recoveryretry";
    const { json } = await registerUser({
      username,
      password: "retry-original-password-123",
      ownership_pubkey: "recovery-retry-key",
      ownership_ciphertext: "recovery-retry-envelope",
    });
    await env.DB.prepare("UPDATE users SET email = ?, email_verified = 1 WHERE localpart = ?")
      .bind("recovery-retry@example.com", username).run();
    const token = "retryable-password-reset-token-value-2026";
    const tokenHash = await hashOpaqueToken(token);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at) VALUES (?, 'password_reset', ?, ?, ?, ?)",
    ).bind(tokenHash, username, "recovery-retry@example.com", now, now + 60_000).run();
    await env.DB.prepare(`CREATE TRIGGER fail_recoveryretry_password_update
      BEFORE UPDATE OF pw_hash ON users WHEN NEW.localpart = '${username}'
      BEGIN SELECT RAISE(ABORT, 'forced update failure'); END`).run();
    try {
      const failed = await apiRequest("/api/account/password-reset/complete", {
        method: "POST", body: JSON.stringify({ token, new_password: "retry-new-password-456" }),
      });
      expect(failed.status).toBe(500);
      const stillAvailable = await env.DB.prepare("SELECT token_hash FROM account_action_tokens WHERE token_hash = ?")
        .bind(tokenHash).first();
      expect(stillAvailable).not.toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_recoveryretry_password_update").run();
    }

    const retry = await apiRequest("/api/account/password-reset/complete", {
      method: "POST", body: JSON.stringify({ token, new_password: "retry-new-password-456" }),
    });
    expect(retry.status).toBe(204);
    const oldSession = await apiRequest("/api/me/ownership", {
      headers: { Authorization: `Bearer ${json.token as string}` },
    });
    expect(oldSession.status).toBe(401);
  });
});

describe("email verification", () => {
  it("accepts a valid link once and marks only its matching account email verified", async () => {
    const username = "emailverifycontract";
    const { status } = await registerUser({
      username,
      password: "verification-password-123",
      ownership_pubkey: "verification-test-key",
      ownership_ciphertext: "verification-test-envelope",
    });
    expect(status).toBe(200);
    await env.DB.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE localpart = ?")
      .bind("verify-contract@example.com", username).run();
    const token = "single-use-email-verification-token-value";
    const tokenHash = await hashOpaqueToken(token);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at) VALUES (?, 'email_verification', ?, ?, ?, ?)",
    ).bind(tokenHash, username, "verify-contract@example.com", now, now + 60_000).run();

    const verified = await apiRequest("/api/account/email/verify", {
      method: "POST", body: JSON.stringify({ token }),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ ok: true, email: "verify-contract@example.com" });
    const row = await env.DB.prepare("SELECT email_verified FROM users WHERE localpart = ?")
      .bind(username).first<{ email_verified: number }>();
    expect(row?.email_verified).toBe(1);

    const replay = await apiRequest("/api/account/email/verify", {
      method: "POST", body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(400);
  });

  it("limits unverified sessions to verification and account basics when email is required", async () => {
    const username = "emailgatecontract";
    const registered = await registerUser({
      username,
      password: "verification-gate-password-123",
      ownership_pubkey: "verification-gate-key",
      ownership_ciphertext: "verification-gate-envelope",
    });
    expect(registered.status).toBe(200);
    const { json } = registered;
    await env.DB.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE localpart = ?")
      .bind("gate-contract@example.com", username).run();
    const previousRequirements = env.ROOT_REQUIREMENTS;
    env.ROOT_REQUIREMENTS = "email";
    try {
      const protectedResponse = await apiRequest("/api/me/passkeys", {
        headers: { Authorization: `Bearer ${json.token as string}` },
      });
      expect(await protectedResponse.json()).toEqual({ error: "EMAIL_VERIFICATION_REQUIRED" });
      expect(protectedResponse.status).toBe(403);

      const accountBasics = await apiRequest("/api/me/ownership", {
        headers: { Authorization: `Bearer ${json.token as string}` },
      });
      expect(accountBasics.status).toBe(200);
    } finally {
      env.ROOT_REQUIREMENTS = previousRequirements;
    }
  });
});

describe("SSO-required account boundaries", () => {
  it("rejects local recovery and email mutation when local authentication is disabled", async () => {
    const previousMode = env.SSO_MODE;
    env.SSO_MODE = "required";
    try {
      const resetRequest = await apiRequest("/api/account/password-reset", {
        method: "POST", body: JSON.stringify({ email: "member@example.com" }),
      });
      expect(resetRequest.status).toBe(403);
      expect(await resetRequest.json()).toEqual({ error: "SSO_REQUIRED" });

      const resetComplete = await apiRequest("/api/account/password-reset/complete", {
        method: "POST", body: JSON.stringify({ token: "opaque-token", new_password: "new-password-123" }),
      });
      expect(resetComplete.status).toBe(403);
      expect(await resetComplete.json()).toEqual({ error: "SSO_REQUIRED" });

      const emailChange = await apiRequest("/api/me/email", {
        method: "POST", body: JSON.stringify({ email: "member@example.com" }),
      });
      expect(emailChange.status).toBe(403);
      expect(await emailChange.json()).toEqual({ error: "SSO_REQUIRED" });
    } finally {
      env.SSO_MODE = previousMode;
    }
  });
});
