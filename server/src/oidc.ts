import {
  createLocalJWKSet,
  EncryptJWT,
  jwtDecrypt,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { base64UrlEncode } from "./auth";
import type { SsoRuntimeConfig } from "./config";
import { HOME_DOMAIN, instanceDomain, type ServerRole } from "./types";
import { isValidEmail } from "./users";

const AUTH_REQUEST_TTL_S = 10 * 60;
const LOGIN_COMPLETION_TTL_S = 2 * 60;
const OIDC_FETCH_TIMEOUT_MS = 5_000;
const OIDC_JSON_MAX_BYTES = 1024 * 1024;
const OIDC_TOKEN_MAX_BYTES = 64 * 1024;
const OIDC_SUBJECT_RE = /^[\x21-\x7e]{1,255}$/;
const TRANSACTION_COOKIE = "__Host-omew-oidc";
const DEVELOPMENT_TRANSACTION_COOKIE = "omew-oidc-dev";

type OidcFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const SAFE_ID_TOKEN_ALGORITHMS = ["RS256", "PS256", "ES256"] as const;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported: string[];
}

interface OidcTransactionData {
  typ: "oidc_transaction";
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  return_to: string;
}

interface OidcTransactionClaims extends JWTPayload, OidcTransactionData {}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
}

export interface OidcUserRow {
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
}

export class OidcError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "OidcError";
  }
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function randomBase64Url(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function endpointUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const localDevelopment = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !localDevelopment) || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new OidcError("SSO_UPSTREAM_INVALID", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchJson(
  url: URL,
  init: RequestInit,
  fetcher: OidcFetch,
  limit = OIDC_JSON_MAX_BYTES,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(OIDC_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new OidcError("SSO_UPSTREAM_UNAVAILABLE", 502);
  }
  if (!response.ok) throw new OidcError("SSO_UPSTREAM_ERROR", 502);
  const contentType = response.headers.get("Content-Type");
  if (contentType && !contentType.toLowerCase().includes("json")) {
    throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  }
  try {
    const parsed = JSON.parse(await readBoundedText(response, limit));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function discoveryUrl(issuer: string): URL {
  return new URL(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
}

async function discover(config: SsoRuntimeConfig, fetcher: OidcFetch): Promise<OidcDiscovery> {
  const payload = await fetchJson(
    discoveryUrl(config.issuer),
    { method: "GET", headers: { Accept: "application/json" } },
    fetcher,
  );
  const authorizationEndpoint = endpointUrl(payload.authorization_endpoint);
  const tokenEndpoint = endpointUrl(payload.token_endpoint);
  const userinfoEndpoint = endpointUrl(payload.userinfo_endpoint);
  const jwksUri = endpointUrl(payload.jwks_uri);
  const algorithms = stringArray(payload.id_token_signing_alg_values_supported);
  const supportedAlgorithms = algorithms?.filter((algorithm) =>
    (SAFE_ID_TOKEN_ALGORITHMS as readonly string[]).includes(algorithm)
  );
  if (
    payload.issuer !== config.issuer ||
    !authorizationEndpoint ||
    !tokenEndpoint ||
    !userinfoEndpoint ||
    !jwksUri ||
    !supportedAlgorithms?.length
  ) {
    throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  }
  const responseTypes = stringArray(payload.response_types_supported);
  if (responseTypes && !responseTypes.includes("code")) throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  const scopes = stringArray(payload.scopes_supported);
  if (scopes && !scopes.includes("openid")) throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  const challengeMethods = stringArray(payload.code_challenge_methods_supported);
  if (challengeMethods && !challengeMethods.includes("S256")) throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  const authMethods = stringArray(payload.token_endpoint_auth_methods_supported);
  if (authMethods && !authMethods.includes("client_secret_basic")) {
    throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  }
  return {
    issuer: config.issuer,
    authorization_endpoint: authorizationEndpoint.toString(),
    token_endpoint: tokenEndpoint.toString(),
    userinfo_endpoint: userinfoEndpoint.toString(),
    jwks_uri: jwksUri.toString(),
    response_types_supported: responseTypes,
    scopes_supported: scopes,
    code_challenge_methods_supported: challengeMethods,
    token_endpoint_auth_methods_supported: authMethods,
    id_token_signing_alg_values_supported: supportedAlgorithms,
  };
}

function trustedRequestOrigin(request: Request, env: Env): string {
  const url = new URL(request.url);
  const domain = instanceDomain(env);
  if (domain === HOME_DOMAIN) {
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new OidcError("SSO_REDIRECT_INVALID", 400);
    }
    return url.origin;
  }
  if (url.protocol !== "https:" || url.hostname !== domain || url.port) {
    throw new OidcError("SSO_REDIRECT_INVALID", 400);
  }
  return url.origin;
}

export function oidcRedirectUri(request: Request, env: Env): string {
  return `${trustedRequestOrigin(request, env)}/api/auth/oidc/callback`;
}

function safeReturnTo(value: string | null): string {
  if (!value || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f#]/.test(value)) return "/";
  return value;
}

function transactionCookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? TRANSACTION_COOKIE : DEVELOPMENT_TRANSACTION_COOKIE;
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  const expires = maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${expires}${secure ? "; Secure" : ""}`;
}

function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`))
    .map((entry) => entry.slice(name.length + 1));
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

async function transactionKey(secret: string): Promise<Uint8Array> {
  const material = new TextEncoder().encode(`OMEW OIDC transaction\u0000${secret}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

async function createTransactionCookie(claims: OidcTransactionData, secret: string): Promise<string> {
  return new EncryptJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(nowS() + AUTH_REQUEST_TTL_S)
    .setJti(crypto.randomUUID())
    .encrypt(await transactionKey(secret));
}

async function readTransactionCookie(token: string, secret: string): Promise<OidcTransactionClaims> {
  try {
    const { payload, protectedHeader } = await jwtDecrypt<OidcTransactionClaims>(token, await transactionKey(secret), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      clockTolerance: 30,
    });
    if (
      protectedHeader.alg !== "dir" ||
      protectedHeader.enc !== "A256GCM" ||
      payload.typ !== "oidc_transaction" ||
      typeof payload.state !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.code_verifier !== "string" ||
      typeof payload.redirect_uri !== "string" ||
      typeof payload.return_to !== "string"
    ) {
      throw new Error("invalid transaction");
    }
    return payload;
  } catch {
    throw new OidcError("SSO_STATE_INVALID", 400);
  }
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
  });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

export function clearOidcTransactionCookie(request: Request): string {
  return cookieHeader(transactionCookieName(request), "", 0, new URL(request.url).protocol === "https:");
}

export async function beginOidcAuthorization(
  request: Request,
  env: Env,
  config: SsoRuntimeConfig,
  fetcher: OidcFetch = fetch,
): Promise<Response> {
  if (!config.configured) throw new OidcError("SSO_NOT_CONFIGURED", 503);
  const metadata = await discover(config, fetcher);
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const redirectUri = oidcRedirectUri(request, env);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  const transaction = await createTransactionCookie({
    typ: "oidc_transaction",
    state,
    nonce,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    return_to: returnTo,
  }, env.DEV_TOKEN_SECRET);

  const authorization = new URL(metadata.authorization_endpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("response_mode", "query");
  authorization.searchParams.set("client_id", config.client_id);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", "openid profile email");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("code_challenge", await sha256Base64Url(codeVerifier));
  authorization.searchParams.set("code_challenge_method", "S256");

  const secure = new URL(request.url).protocol === "https:";
  return redirect(authorization.toString(), cookieHeader(transactionCookieName(request), transaction, AUTH_REQUEST_TTL_S, secure));
}

function exactParameter(url: URL, name: string, maxLength: number): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0]!.length > 0 && values[0]!.length <= maxLength ? values[0]! : null;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/[-_.!~*'()]|%20/g, (part) =>
    part === "%20" ? "+" : `%${part.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function exchangeCode(
  code: string,
  transaction: OidcTransactionClaims,
  config: SsoRuntimeConfig,
  metadata: OidcDiscovery,
  fetcher: OidcFetch,
): Promise<{ id_token: string; access_token: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: transaction.redirect_uri,
    code_verifier: transaction.code_verifier,
  });
  const credentials = `${formEncode(config.client_id)}:${formEncode(config.client_secret)}`;
  const payload = await fetchJson(
    new URL(metadata.token_endpoint),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${base64Utf8(credentials)}`,
        "Cache-Control": "no-store",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    fetcher,
    OIDC_TOKEN_MAX_BYTES,
  );
  if (
    typeof payload.id_token !== "string" ||
    payload.id_token.length === 0 ||
    payload.id_token.length > OIDC_TOKEN_MAX_BYTES ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    payload.access_token.length > OIDC_TOKEN_MAX_BYTES ||
    typeof payload.token_type !== "string" ||
    payload.token_type.toLowerCase() !== "bearer"
  ) {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  return { id_token: payload.id_token, access_token: payload.access_token };
}

async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  config: SsoRuntimeConfig,
  metadata: OidcDiscovery,
  fetcher: OidcFetch,
): Promise<JWTPayload> {
  const jwksPayload = await fetchJson(
    new URL(metadata.jwks_uri),
    { method: "GET", headers: { Accept: "application/jwk-set+json, application/json" } },
    fetcher,
  );
  if (!Array.isArray(jwksPayload.keys) || jwksPayload.keys.length === 0 || jwksPayload.keys.length > 100) {
    throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(jwksPayload as unknown as JSONWebKeySet), {
      issuer: config.issuer,
      audience: config.client_id,
      algorithms: metadata.id_token_signing_alg_values_supported,
      clockTolerance: 60,
      maxTokenAge: 600,
    }));
  } catch {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  if (
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    payload.nonce !== expectedNonce ||
    typeof payload.sub !== "string" ||
    !OIDC_SUBJECT_RE.test(payload.sub)
  ) {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
  if (!audiences?.includes(config.client_id) || (audiences.length > 1 && payload.azp !== config.client_id)) {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  return payload;
}

async function fetchUserInfo(accessToken: string, metadata: OidcDiscovery, fetcher: OidcFetch): Promise<Record<string, unknown>> {
  return fetchJson(
    new URL(metadata.userinfo_endpoint),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Cache-Control": "no-store",
      },
    },
    fetcher,
  );
}

function preferredDisplayName(idToken: JWTPayload, userInfo: Record<string, unknown>): string {
  for (const value of [userInfo.name, userInfo.preferred_username, idToken.name, idToken.preferred_username]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return [...trimmed].slice(0, 32).join("");
  }
  return "SSO 用户";
}

export async function finishOidcAuthorization(
  request: Request,
  env: Env,
  config: SsoRuntimeConfig,
  fetcher: OidcFetch = fetch,
): Promise<{ identity: OidcIdentity; return_to: string }> {
  if (!config.configured) throw new OidcError("SSO_NOT_CONFIGURED", 503);
  const url = new URL(request.url);
  const state = exactParameter(url, "state", 512);
  const cookie = readCookie(request, transactionCookieName(request));
  if (!state || !cookie) throw new OidcError("SSO_STATE_INVALID", 400);
  const transaction = await readTransactionCookie(cookie, env.DEV_TOKEN_SECRET);
  if (transaction.state !== state || transaction.redirect_uri !== oidcRedirectUri(request, env)) {
    throw new OidcError("SSO_STATE_INVALID", 400);
  }
  if (exactParameter(url, "error", 256)) throw new OidcError("SSO_PROVIDER_ERROR", 401);
  const code = exactParameter(url, "code", 4096);
  if (!code) throw new OidcError("SSO_STATE_INVALID", 400);

  const metadata = await discover(config, fetcher);
  const tokens = await exchangeCode(code, transaction, config, metadata, fetcher);
  const idToken = await verifyIdToken(tokens.id_token, transaction.nonce, config, metadata, fetcher);
  const userInfo = await fetchUserInfo(tokens.access_token, metadata, fetcher);
  if (userInfo.sub !== idToken.sub) throw new OidcError("SSO_TOKEN_INVALID", 401);
  const rawEmail = typeof userInfo.email === "string" ? userInfo.email : idToken.email;
  const email = typeof rawEmail === "string" && rawEmail.length <= 254 && isValidEmail(rawEmail.trim()) ? rawEmail.trim() : null;
  const emailVerified = userInfo.email_verified === true || (userInfo.email_verified === undefined && idToken.email_verified === true);
  return {
    identity: {
      issuer: config.issuer,
      subject: idToken.sub as string,
      display_name: preferredDisplayName(idToken, userInfo),
      email,
      email_verified: email !== null && emailVerified,
    },
    return_to: transaction.return_to,
  };
}

const USER_SELECT =
  "SELECT u.localpart, u.display_name, u.avatar, u.cover, u.bio, u.status, u.server_role, u.email, u.email_verified, u.totp_enabled " +
  "FROM oidc_identities i JOIN users u ON u.localpart = i.localpart WHERE i.issuer = ? AND i.subject = ?";

async function existingOidcUser(env: Env, identity: OidcIdentity): Promise<OidcUserRow | null> {
  return env.DB.prepare(USER_SELECT).bind(identity.issuer, identity.subject).first<OidcUserRow>();
}

function newSsoLocalpart(): string {
  return `sso-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export async function mapOidcIdentity(env: Env, identity: OidcIdentity): Promise<OidcUserRow> {
  const existing = await existingOidcUser(env, identity);
  const timestamp = Date.now();
  if (existing) {
    const email = identity.email ?? existing.email;
    const emailVerified = identity.email === null ? existing.email_verified : identity.email_verified ? 1 : 0;
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET display_name = ?, email = ?, email_verified = ? WHERE localpart = ?")
        .bind(identity.display_name, email, emailVerified, existing.localpart),
      env.DB.prepare("UPDATE oidc_identities SET last_login_at = ? WHERE issuer = ? AND subject = ?")
        .bind(timestamp, identity.issuer, identity.subject),
    ]);
    return { ...existing, display_name: identity.display_name, email, email_verified: emailVerified };
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const localpart = newSsoLocalpart();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users (localpart, display_name, status, created_at, server_role, email, email_verified) VALUES (?, ?, 'active', ?, 'user', ?, ?)",
        ).bind(localpart, identity.display_name, timestamp, identity.email, identity.email_verified ? 1 : 0),
        env.DB.prepare(
          "INSERT INTO oidc_identities (issuer, subject, localpart, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(identity.issuer, identity.subject, localpart, timestamp, timestamp),
      ]);
      const created = await existingOidcUser(env, identity);
      if (created) return created;
    } catch {
      const raced = await existingOidcUser(env, identity);
      if (raced) return raced;
    }
  }
  throw new OidcError("SSO_IDENTITY_ERROR", 500);
}

export async function createOidcLoginCompletion(env: Env, localpart: string): Promise<string> {
  await env.DB.prepare("DELETE FROM oidc_login_completions WHERE expires_at <= ?").bind(nowS()).run();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomBase64Url(32);
    try {
      await env.DB.prepare("INSERT INTO oidc_login_completions (code_hash, localpart, expires_at) VALUES (?, ?, ?)")
        .bind(await sha256Base64Url(code), localpart, nowS() + LOGIN_COMPLETION_TTL_S)
        .run();
      return code;
    } catch {
      // Retry only a vanishingly unlikely random-code collision.
    }
  }
  throw new OidcError("SSO_IDENTITY_ERROR", 500);
}

export async function consumeOidcLoginCompletion(env: Env, code: string): Promise<string | null> {
  if (!code || code.length > 512) return null;
  await env.DB.prepare("DELETE FROM oidc_login_completions WHERE expires_at <= ?").bind(nowS()).run();
  const row = await env.DB.prepare(
    "DELETE FROM oidc_login_completions WHERE code_hash = ? AND expires_at > ? RETURNING localpart",
  ).bind(await sha256Base64Url(code), nowS()).first<{ localpart: string }>();
  return row?.localpart ?? null;
}

export function oidcLoginCompletionRedirect(request: Request, env: Env, returnTo: string, code: string): Response {
  const destination = new URL(safeReturnTo(returnTo), trustedRequestOrigin(request, env));
  destination.hash = new URLSearchParams({ sso_complete: code }).toString();
  return redirect(destination.toString(), clearOidcTransactionCookie(request));
}
