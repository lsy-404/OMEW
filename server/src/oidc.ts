import {
  CompactSign,
  createLocalJWKSet,
  decodeJwt,
  EncryptJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtDecrypt,
  jwtVerify,
  SignJWT,
  calculateJwkThumbprint,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { base64UrlDecode, base64UrlEncode, signToken, verifyToken } from "./auth";
import type { SsoRuntimeConfig } from "./config";
import { HOME_DOMAIN, instanceDomain, type ServerRole, type SessionTokenClaims } from "./types";
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
  token_endpoint_auth_method: "client_secret_basic" | "client_secret_post";
  id_token_signing_alg_values_supported: string[];
  response_modes_supported?: string[];
  pushed_authorization_request_endpoint?: string;
  end_session_endpoint?: string;
  device_authorization_endpoint?: string;
  backchannel_authentication_endpoint?: string;
  dpop_signing_alg_values_supported?: string[];
  grant_types_supported?: string[];
}

interface OidcTransactionData {
  typ: "oidc_transaction";
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  return_to: string;
  use_par: boolean;
  use_jarm: boolean;
  dpop_private_jwk?: JsonWebKey;
  dpop_public_jwk?: JsonWebKey;
  dpop_jkt?: string;
}

interface OidcTransactionClaims extends JWTPayload, OidcTransactionData {}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
}

export interface OidcTokenSet {
  id_token: string;
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  cnf?: { jkt: string };
  dpop_private_jwk?: JsonWebKey;
  dpop_public_jwk?: JsonWebKey;
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
  if (authMethods && !authMethods.some((method) => ["client_secret_basic", "client_secret_post"].includes(method))) {
    throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  }
  const tokenEndpointAuthMethod = !authMethods || authMethods.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post";
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
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    id_token_signing_alg_values_supported: supportedAlgorithms,
    response_modes_supported: stringArray(payload.response_modes_supported),
    pushed_authorization_request_endpoint: endpointUrl(payload.pushed_authorization_request_endpoint)?.toString(),
    end_session_endpoint: endpointUrl(payload.end_session_endpoint)?.toString(),
    device_authorization_endpoint: endpointUrl(payload.device_authorization_endpoint)?.toString(),
    backchannel_authentication_endpoint: endpointUrl(payload.backchannel_authentication_endpoint)?.toString(),
    dpop_signing_alg_values_supported: stringArray(payload.dpop_signing_alg_values_supported),
    grant_types_supported: stringArray(payload.grant_types_supported),
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
      typeof payload.return_to !== "string" ||
      typeof payload.use_par !== "boolean" ||
      typeof payload.use_jarm !== "boolean"
    ) {
      throw new Error("invalid transaction");
    }
    return payload;
  } catch {
    throw new OidcError("SSO_STATE_INVALID", 400);
  }
}

function parseJwkSecret(value: string): JsonWebKey | null {
  if (!value) return null;
  try {
    const jwk = JSON.parse(value) as JsonWebKey;
    return jwk && typeof jwk === "object" ? jwk : null;
  } catch {
    throw new OidcError("SSO_CONFIGURATION_INVALID", 503);
  }
}

async function createDpopMaterial(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey; jkt: string }> {
  const keyPair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(keyPair.privateKey);
  const publicJwk = await exportJWK(keyPair.publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateJwk: privateJwk as unknown as JsonWebKey, publicJwk: publicJwk as unknown as JsonWebKey, jkt };
}

async function createDpopProof(privateJwk: JsonWebKey, publicJwk: JsonWebKey, method: string, htu: string): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify({
    htm: method,
    htu,
    iat: nowS(),
    jti: crypto.randomUUID(),
  })))
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
    .sign(await importJWK(privateJwk, "ES256"));
}

async function signedRequestObject(config: SsoRuntimeConfig, parameters: URLSearchParams): Promise<string | null> {
  const jwk = parseJwkSecret(config.jar_private_jwk);
  if (!jwk) return null;
  const claims = Object.fromEntries(parameters.entries());
  const metadata = jwk as JsonWebKey & { alg?: string; kid?: string };
  return new SignJWT(claims)
    .setProtectedHeader({ typ: "oauth-authz-req+jwt", alg: metadata.alg || "RS256", kid: metadata.kid })
    .setIssuer(config.client_id)
    .setAudience(config.issuer)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importJWK(jwk as never, metadata.alg || "RS256"));
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

async function pushAuthorizationRequest(
  metadata: OidcDiscovery,
  config: SsoRuntimeConfig,
  parameters: URLSearchParams,
  fetcher: OidcFetch,
): Promise<string | null> {
  if (!metadata.pushed_authorization_request_endpoint || config.use_par === false) return null;
  const body = new URLSearchParams(parameters);
  const authHeaders = clientAuthenticationHeaders(config, metadata, body);
  const payload = await fetchJson(new URL(metadata.pushed_authorization_request_endpoint), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-store",
      ...authHeaders,
    },
    body,
  }, fetcher, OIDC_TOKEN_MAX_BYTES);
  if (typeof payload.request_uri !== "string" || payload.request_uri.length > 2048 || typeof payload.expires_in !== "number" || payload.expires_in <= 0) throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  return payload.request_uri;
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
  const useJarm = config.use_jarm && metadata.response_modes_supported?.includes("jwt") === true;
  const dpop = config.use_dpop && metadata.dpop_signing_alg_values_supported?.includes("ES256") === true
    ? await createDpopMaterial()
    : null;
  const parameters = new URLSearchParams({
    response_type: "code",
    response_mode: useJarm ? "jwt" : "query",
    client_id: config.client_id,
    redirect_uri: redirectUri,
    scope: requestedScopes(metadata),
    state,
    nonce,
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: "S256",
    ...(dpop ? { dpop_jkt: dpop.jkt } : {}),
  });
  const requestObject = await signedRequestObject(config, parameters);
  if (requestObject) parameters.set("request", requestObject);
  const requestUri = await pushAuthorizationRequest(metadata, config, parameters, fetcher);
  const transaction = await createTransactionCookie({
    typ: "oidc_transaction",
    state,
    nonce,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    return_to: returnTo,
    use_par: Boolean(requestUri),
    use_jarm: useJarm,
    ...(dpop ? { dpop_private_jwk: dpop.privateJwk, dpop_public_jwk: dpop.publicJwk, dpop_jkt: dpop.jkt } : {}),
  }, env.DEV_TOKEN_SECRET);

  const authorization = new URL(metadata.authorization_endpoint);
  if (requestUri) {
    authorization.searchParams.set("client_id", config.client_id);
    authorization.searchParams.set("request_uri", requestUri);
  } else {
    for (const [name, value] of parameters) authorization.searchParams.set(name, value);
  }

  const secure = new URL(request.url).protocol === "https:";
  return redirect(authorization.toString(), cookieHeader(transactionCookieName(request), transaction, AUTH_REQUEST_TTL_S, secure));
}

function requestedScopes(metadata: OidcDiscovery): string {
  const supported = metadata.scopes_supported;
  return ["openid", "profile", "email", "offline_access"]
    .filter((scope) => !supported || supported.includes(scope))
    .join(" ");
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

function clientAuthenticationHeaders(config: SsoRuntimeConfig, metadata: OidcDiscovery, body: URLSearchParams): Record<string, string> {
  if (metadata.token_endpoint_auth_method === "client_secret_post") {
    body.set("client_id", config.client_id);
    body.set("client_secret", config.client_secret);
    return {};
  }
  return { Authorization: `Basic ${base64Utf8(`${formEncode(config.client_id)}:${formEncode(config.client_secret)}`)}` };
}

async function exchangeCode(
  code: string,
  transaction: OidcTransactionClaims,
  config: SsoRuntimeConfig,
  metadata: OidcDiscovery,
  fetcher: OidcFetch,
): Promise<OidcTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: transaction.redirect_uri,
    code_verifier: transaction.code_verifier,
  });
  const authHeaders = clientAuthenticationHeaders(config, metadata, body);
  const dpopHeader = transaction?.dpop_private_jwk && transaction.dpop_public_jwk
    ? await createDpopProof(transaction.dpop_private_jwk, transaction.dpop_public_jwk, "POST", metadata.token_endpoint)
    : undefined;
  const payload = await fetchJson(
    new URL(metadata.token_endpoint),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        "Content-Type": "application/x-www-form-urlencoded",
        ...authHeaders,
        ...(dpopHeader ? { DPoP: dpopHeader } : {}),
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
    !["bearer", "dpop"].includes(payload.token_type.toLowerCase())
  ) {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  const tokenType = payload.token_type.toLowerCase();
  if (transaction.dpop_jkt && (tokenType !== "dpop" || !dpopConfirmationMatches(payload.cnf, transaction.dpop_jkt))) {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
  if (!transaction.dpop_jkt && tokenType === "dpop") throw new OidcError("SSO_TOKEN_INVALID", 401);
  return {
    id_token: payload.id_token,
    access_token: payload.access_token,
    token_type: payload.token_type,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    cnf: dpopConfirmation(payload.cnf),
    ...(transaction?.dpop_private_jwk && transaction.dpop_public_jwk
      ? { dpop_private_jwk: transaction.dpop_private_jwk, dpop_public_jwk: transaction.dpop_public_jwk }
      : {}),
  };
}

async function providerJwks(metadata: OidcDiscovery, fetcher: OidcFetch): Promise<JSONWebKeySet> {
  const jwksPayload = await fetchJson(
    new URL(metadata.jwks_uri),
    { method: "GET", headers: { Accept: "application/jwk-set+json, application/json" } },
    fetcher,
  );
  if (!Array.isArray(jwksPayload.keys) || jwksPayload.keys.length === 0 || jwksPayload.keys.length > 100) throw new OidcError("SSO_UPSTREAM_INVALID", 502);
  return jwksPayload as unknown as JSONWebKeySet;
}

async function verifyJarm(
  response: string,
  config: SsoRuntimeConfig,
  metadata: OidcDiscovery,
  fetcher: OidcFetch,
): Promise<JWTPayload> {
  try {
    const payload = (await jwtVerify(response, createLocalJWKSet(await providerJwks(metadata, fetcher)), {
      issuer: config.issuer,
      audience: config.client_id,
      algorithms: metadata.id_token_signing_alg_values_supported,
      clockTolerance: 60,
    })).payload;
    if (typeof payload.exp !== "number" || typeof payload.state !== "string" || (!payload.code && !payload.error)) throw new Error("invalid JARM");
    return payload;
  } catch {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
}

async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  config: SsoRuntimeConfig,
  metadata: OidcDiscovery,
  fetcher: OidcFetch,
  requireNonce = true,
): Promise<JWTPayload> {
  const jwksPayload = await providerJwks(metadata, fetcher);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(jwksPayload), {
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
    (requireNonce && payload.nonce !== expectedNonce) ||
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

async function fetchUserInfo(accessToken: string, metadata: OidcDiscovery, fetcher: OidcFetch, transaction?: OidcTransactionClaims): Promise<Record<string, unknown>> {
  const dpopHeader = transaction?.dpop_private_jwk && transaction?.dpop_public_jwk
    ? await createDpopProof(transaction.dpop_private_jwk, transaction.dpop_public_jwk, "GET", metadata.userinfo_endpoint)
    : undefined;
  return fetchJson(
    new URL(metadata.userinfo_endpoint),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `${transaction?.dpop_private_jwk ? "DPoP" : "Bearer"} ${accessToken}`,
        "Cache-Control": "no-store",
        ...(dpopHeader ? { DPoP: dpopHeader } : {}),
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
): Promise<{ identity: OidcIdentity; return_to: string; tokens: OidcTokenSet }> {
  if (!config.configured) throw new OidcError("SSO_NOT_CONFIGURED", 503);
  const url = new URL(request.url);
  const cookie = readCookie(request, transactionCookieName(request));
  if (!cookie) throw new OidcError("SSO_STATE_INVALID", 400);
  const transaction = await readTransactionCookie(cookie, env.DEV_TOKEN_SECRET);
  const metadata = await discover(config, fetcher);
  let responseClaims: JWTPayload | null = null;
  if (transaction.use_jarm) {
    const response = exactParameter(url, "response", OIDC_TOKEN_MAX_BYTES);
    if (!response) throw new OidcError("SSO_STATE_INVALID", 400);
    responseClaims = await verifyJarm(response, config, metadata, fetcher);
  }
  const state = responseClaims?.state && typeof responseClaims.state === "string"
    ? responseClaims.state
    : exactParameter(url, "state", 512);
  if (!state || transaction.state !== state || transaction.redirect_uri !== oidcRedirectUri(request, env)) throw new OidcError("SSO_STATE_INVALID", 400);
  const error = responseClaims?.error && typeof responseClaims.error === "string" ? responseClaims.error : exactParameter(url, "error", 256);
  if (error) throw new OidcError("SSO_PROVIDER_ERROR", 401);
  const code = responseClaims?.code && typeof responseClaims.code === "string" ? responseClaims.code : exactParameter(url, "code", 4096);
  if (!code) throw new OidcError("SSO_STATE_INVALID", 400);

  const tokens = await exchangeCode(code, transaction, config, metadata, fetcher);
  const idToken = await verifyIdToken(tokens.id_token, transaction.nonce, config, metadata, fetcher);
  const userInfo = await fetchUserInfo(tokens.access_token, metadata, fetcher, transaction);
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
    tokens,
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

async function tokenCiphertext(value: string, secret: string): Promise<string> {
  return new EncryptJWT({ value })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("31d")
    .setJti(crypto.randomUUID())
    .encrypt(await transactionKey(secret));
}

async function tokenPlaintext(value: string, secret: string): Promise<string> {
  try {
    const { payload, protectedHeader } = await jwtDecrypt<{ value?: string }>(value, await transactionKey(secret), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      clockTolerance: 30,
    });
    if (protectedHeader.alg !== "dir" || protectedHeader.enc !== "A256GCM" || typeof payload.value !== "string") throw new Error("invalid token");
    return payload.value;
  } catch {
    throw new OidcError("SSO_TOKEN_INVALID", 401);
  }
}

function sessionJti(sessionToken: string): string | null {
  try {
    const [payload] = sessionToken.split(".");
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload || ""))) as Partial<SessionTokenClaims>;
    return claims.typ === "session" && typeof claims.jti === "string" ? claims.jti : null;
  } catch {
    return null;
  }
}

export async function storeOidcSession(
  env: Env,
  sessionToken: string,
  localpart: string,
  config: SsoRuntimeConfig,
  tokens: OidcTokenSet,
): Promise<void> {
  const jti = sessionJti(sessionToken);
  if (!jti) throw new OidcError("SSO_TOKEN_INVALID", 500);
  const timestamp = nowS();
  const refreshCiphertext = tokens.refresh_token ? await tokenCiphertext(tokens.refresh_token, env.DEV_TOKEN_SECRET) : null;
  const idCiphertext = tokens.id_token ? await tokenCiphertext(tokens.id_token, env.DEV_TOKEN_SECRET) : null;
  const dpopCiphertext = tokens.dpop_private_jwk && tokens.dpop_public_jwk
    ? await tokenCiphertext(JSON.stringify({ private: tokens.dpop_private_jwk, public: tokens.dpop_public_jwk }), env.DEV_TOKEN_SECRET)
    : null;
  await env.DB.prepare(`
    INSERT OR REPLACE INTO oidc_sessions
      (session_jti, localpart, issuer, client_id, refresh_token_ciphertext, id_token_ciphertext,
       dpop_key_ciphertext, access_token_expires_at, refresh_token_expires_at, created_at, updated_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM oidc_sessions WHERE session_jti = ?), ?), ?, NULL)
  `).bind(jti, localpart, config.issuer, config.client_id, refreshCiphertext, idCiphertext, dpopCiphertext, tokens.expires_in ? timestamp + tokens.expires_in : null, refreshCiphertext ? timestamp + 30 * 24 * 60 * 60 : null, jti, timestamp, timestamp).run();
}

export async function refreshOidcSession(
  env: Env,
  session: SessionTokenClaims,
  config: SsoRuntimeConfig,
  fetcher: OidcFetch = fetch,
): Promise<{ token: string; identity: OidcIdentity }> {
  if (session.auth_source !== "sso") throw new OidcError("SSO_REQUIRED", 401);
  const row = await env.DB.prepare(
    `SELECT s.*, i.subject AS bound_subject
       FROM oidc_sessions s
       JOIN oidc_identities i ON i.issuer = s.issuer AND i.localpart = s.localpart
      WHERE s.session_jti = ? AND s.revoked_at IS NULL`,
  ).bind(session.jti).first<{ localpart: string; issuer: string; bound_subject: string; refresh_token_ciphertext: string | null; id_token_ciphertext: string | null; dpop_key_ciphertext: string | null }>();
  if (!row?.refresh_token_ciphertext) throw new OidcError("SSO_REFRESH_UNAVAILABLE", 401);
  const refreshToken = await tokenPlaintext(row.refresh_token_ciphertext, env.DEV_TOKEN_SECRET);
  const metadata = await discover(config, fetcher);
  const dpop = row.dpop_key_ciphertext ? JSON.parse(await tokenPlaintext(row.dpop_key_ciphertext, env.DEV_TOKEN_SECRET)) as { private?: JsonWebKey; public?: JsonWebKey } : null;
  if (row.dpop_key_ciphertext && (!dpop?.private || !dpop.public)) throw new OidcError("SSO_TOKEN_INVALID", 401);
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const dpopHeader = dpop?.private && dpop.public ? await createDpopProof(dpop.private, dpop.public, "POST", metadata.token_endpoint) : undefined;
  const authHeaders = clientAuthenticationHeaders(config, metadata, body);
  const payload = await fetchJson(new URL(metadata.token_endpoint), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", ...authHeaders, ...(dpopHeader ? { DPoP: dpopHeader } : {}) },
    body,
  }, fetcher, OIDC_TOKEN_MAX_BYTES);
  if (typeof payload.access_token !== "string" || typeof payload.token_type !== "string" || !["bearer", "dpop"].includes(payload.token_type.toLowerCase())) throw new OidcError("SSO_TOKEN_INVALID", 401);
  const expectedDpopJkt = dpop?.public ? await calculateJwkThumbprint(dpop.public, "sha256") : null;
  if (expectedDpopJkt && (payload.token_type.toLowerCase() !== "dpop" || !dpopConfirmationMatches(payload.cnf, expectedDpopJkt))) throw new OidcError("SSO_TOKEN_INVALID", 401);
  if (!expectedDpopJkt && payload.token_type.toLowerCase() === "dpop") throw new OidcError("SSO_TOKEN_INVALID", 401);
  const idToken = typeof payload.id_token === "string" ? payload.id_token : null;
  const idClaims: JWTPayload = idToken
    ? await verifyIdToken(idToken, "", config, metadata, fetcher, false)
    : { sub: row.bound_subject };
  if (typeof idClaims.sub !== "string" || idClaims.sub !== row.bound_subject) throw new OidcError("SSO_TOKEN_INVALID", 401);
  const identity: OidcIdentity = { issuer: config.issuer, subject: idClaims.sub, display_name: preferredDisplayName(idClaims, {}), email: typeof idClaims.email === "string" && isValidEmail(idClaims.email) ? idClaims.email : null, email_verified: idClaims.email_verified === true };
  const newRefresh = typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken;
  const accessTokenExpiresAt = typeof payload.expires_in === "number" ? nowS() + payload.expires_in : null;
  await env.DB.prepare("UPDATE oidc_sessions SET refresh_token_ciphertext = ?, id_token_ciphertext = ?, access_token_expires_at = ?, refresh_token_expires_at = ?, updated_at = ? WHERE session_jti = ? AND revoked_at IS NULL").bind(await tokenCiphertext(newRefresh, env.DEV_TOKEN_SECRET), idToken ? await tokenCiphertext(idToken, env.DEV_TOKEN_SECRET) : row.id_token_ciphertext, accessTokenExpiresAt, nowS() + 30 * 24 * 60 * 60, nowS(), session.jti).run();
  const token = await signToken({ ...session, exp: nowS() + 24 * 60 * 60, jti: crypto.randomUUID() }, env.DEV_TOKEN_SECRET);
  await env.DB.prepare("UPDATE oidc_sessions SET session_jti = ?, updated_at = ? WHERE session_jti = ?").bind(sessionJti(token), nowS(), session.jti).run();
  return { token, identity };
}

function dpopConfirmation(value: unknown): { jkt: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const jkt = (value as { jkt?: unknown }).jkt;
  return typeof jkt === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(jkt) ? { jkt } : undefined;
}

function dpopConfirmationMatches(value: unknown, expected: string): boolean {
  return dpopConfirmation(value)?.jkt === expected;
}

export async function revokeOidcSession(env: Env, session: SessionTokenClaims): Promise<void> {
  if (session.auth_source !== "sso") return;
  await env.DB.prepare("UPDATE oidc_sessions SET revoked_at = ?, updated_at = ? WHERE session_jti = ? AND revoked_at IS NULL").bind(nowS(), nowS(), session.jti).run();
}

export async function oidcLogoutUrl(
  env: Env,
  session: SessionTokenClaims,
  config: SsoRuntimeConfig,
  postLogoutRedirectUri: string,
  fetcher: OidcFetch = fetch,
): Promise<string | null> {
  if (session.auth_source !== "sso") return null;
  const row = await env.DB.prepare("SELECT id_token_ciphertext FROM oidc_sessions WHERE session_jti = ? AND revoked_at IS NULL").bind(session.jti).first<{ id_token_ciphertext: string | null }>();
  if (!row?.id_token_ciphertext) return null;
  const idToken = await tokenPlaintext(row.id_token_ciphertext, env.DEV_TOKEN_SECRET);
  const metadata = await discover(config, fetcher);
  if (!metadata.end_session_endpoint) return null;
  const url = new URL(metadata.end_session_endpoint);
  url.searchParams.set("id_token_hint", idToken);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  url.searchParams.set("state", randomBase64Url(24));
  return url.toString();
}

export async function createOidcLoginCompletion(env: Env, localpart: string, config?: SsoRuntimeConfig, tokens?: OidcTokenSet): Promise<string> {
  await env.DB.prepare("DELETE FROM oidc_login_completions WHERE expires_at <= ?").bind(nowS()).run();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomBase64Url(32);
    try {
      const refreshCiphertext = config && tokens?.refresh_token ? await tokenCiphertext(tokens.refresh_token, env.DEV_TOKEN_SECRET) : null;
      const idCiphertext = config && tokens?.id_token ? await tokenCiphertext(tokens.id_token, env.DEV_TOKEN_SECRET) : null;
      const dpopCiphertext = config && tokens?.dpop_private_jwk && tokens.dpop_public_jwk
        ? await tokenCiphertext(JSON.stringify({ private: tokens.dpop_private_jwk, public: tokens.dpop_public_jwk }), env.DEV_TOKEN_SECRET)
        : null;
      await env.DB.prepare("INSERT INTO oidc_login_completions (code_hash, localpart, expires_at, refresh_token_ciphertext, id_token_ciphertext, dpop_key_ciphertext, token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(await sha256Base64Url(code), localpart, nowS() + LOGIN_COMPLETION_TTL_S, refreshCiphertext, idCiphertext, dpopCiphertext, tokens?.expires_in ? nowS() + tokens.expires_in : null)
        .run();
      return code;
    } catch {
      // Retry only a vanishingly unlikely random-code collision.
    }
  }
  throw new OidcError("SSO_IDENTITY_ERROR", 500);
}

export async function consumeOidcLoginCompletion(env: Env, code: string): Promise<string | null> {
  const details = await consumeOidcLoginCompletionDetails(env, code);
  return details?.localpart ?? null;
}

export async function consumeOidcLoginCompletionDetails(env: Env, code: string): Promise<{
  localpart: string;
  refresh_token_ciphertext: string | null;
  id_token_ciphertext: string | null;
  dpop_key_ciphertext: string | null;
  token_expires_at: number | null;
} | null> {
  if (!code || code.length > 512) return null;
  await env.DB.prepare("DELETE FROM oidc_login_completions WHERE expires_at <= ?").bind(nowS()).run();
  const row = await env.DB.prepare(
    "DELETE FROM oidc_login_completions WHERE code_hash = ? AND expires_at > ? RETURNING localpart, refresh_token_ciphertext, id_token_ciphertext, dpop_key_ciphertext, token_expires_at",
  ).bind(await sha256Base64Url(code), nowS()).first<{
    localpart: string;
    refresh_token_ciphertext: string | null;
    id_token_ciphertext: string | null;
    dpop_key_ciphertext: string | null;
    token_expires_at: number | null;
  }>();
  return row ?? null;
}

export function oidcLoginCompletionRedirect(request: Request, env: Env, returnTo: string, code: string): Response {
  const destination = new URL(safeReturnTo(returnTo), trustedRequestOrigin(request, env));
  destination.hash = new URLSearchParams({ sso_complete: code }).toString();
  return redirect(destination.toString(), clearOidcTransactionCookie(request));
}
