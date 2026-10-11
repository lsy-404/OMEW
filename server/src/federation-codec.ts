import canonicalize from "canonicalize";
import { visit } from "jsonc-parser";
import { base64UrlDecode, base64UrlEncode } from "./auth";

export class ProtocolError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export type JsonObject = Record<string, unknown>;
export interface Envelope extends JsonObject {
  v: number;
  id: string;
  type: string;
  origin: string;
  ts: number;
  payload: JsonObject;
  key_id: string;
  sig: string;
  actor?: string;
  room?: string;
  seq?: number;
}
export const FRESH_MS = 300_000;
export const QUEUE_MS = 86_400_000;
export const RETENTION_MS = 93_600_000;
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function canonicalDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      value,
    ) &&
    !/^\d+(?:\.\d+){3}$/.test(value) &&
    !value.endsWith(".localhost") &&
    !value.endsWith(".local")
  );
}
export function canonicalActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^@[a-z0-9][a-z0-9_.-]{0,63}:[a-z0-9.-]+$/.test(value) &&
    !value.split(":")[0]!.endsWith(".") &&
    !value.split(":")[0]!.endsWith("-") &&
    !value.includes("..") &&
    canonicalDomain(value.slice(value.indexOf(":") + 1))
  );
}
export function canonicalRoom(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}\/(ch|sec)\/[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
  );
}
export function domain(value: string): string {
  return value.slice(value.indexOf(":") + 1);
}
function validateJson(value: unknown, allowNull: boolean): void {
  if (value === null && !allowNull)
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new ProtocolError(400, "OMEW_MALFORMED");
  if (
    typeof value === "string" &&
    (value.normalize("NFC") !== value ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ))
  )
    throw new ProtocolError(400, "OMEW_NOT_CANONICAL");
  if (Array.isArray(value))
    for (const entry of value) validateJson(entry, allowNull);
  if (object(value))
    for (const [key, entry] of Object.entries(value)) {
      validateJson(key, allowNull);
      validateJson(entry, allowNull);
    }
}
export function strictJson(text: string, allowNull = false): unknown {
  const stack: Set<string>[] = [];
  let invalid = false;
  visit(
    text,
    {
      onObjectBegin() {
        stack.push(new Set());
      },
      onObjectProperty(name) {
        const current = stack.at(-1)!;
        if (current.has(name)) invalid = true;
        current.add(name);
      },
      onObjectEnd() {
        stack.pop();
      },
      onError() {
        invalid = true;
      },
    },
    {
      allowTrailingComma: false,
      disallowComments: true,
      allowEmptyContent: false,
    },
  );
  if (invalid) throw new ProtocolError(400, "OMEW_MALFORMED");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError(400, "OMEW_MALFORMED");
  }
  validateJson(value, allowNull);
  return value;
}
export async function boundedJson(
  request: Request | Response,
  max = 65_536,
  allowNull = false,
): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
  if (!request.body) throw new ProtocolError(400, "OMEW_MALFORMED");
  const reader = request.body.getReader();
  const timeout = setTimeout(() => {
    void reader.cancel();
  }, 5_000);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let length = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new ProtocolError(413, "OMEW_ENVELOPE_TOO_LARGE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (declared && Number(declared) !== length)
      throw new ProtocolError(400, "OMEW_MALFORMED");
    return strictJson(text, allowNull);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(400, "OMEW_MALFORMED");
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
export function signingInput(prefix: string, value: JsonObject): Uint8Array {
  validateJson(value, false);
  const { sig: _sig, ...unsigned } = value;
  return new TextEncoder().encode(`${prefix}\0${canonicalize(unsigned)}`);
}
export async function signObject(
  prefix: string,
  value: JsonObject,
  privateKey: CryptoKey,
): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        signingInput(prefix, value),
      ),
    ),
  );
}
export async function verifyObject(
  prefix: string,
  value: JsonObject,
  publicKey: string,
): Promise<boolean> {
  try {
    if (typeof value.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.sig))
      return false;
    const bytes = base64UrlDecode(publicKey);
    if (bytes.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", bytes, "Ed25519", false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      base64UrlDecode(value.sig),
      signingInput(prefix, value),
    );
  } catch {
    return false;
  }
}
export async function keyId(publicKey: string): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", base64UrlDecode(publicKey)),
    ).slice(0, 16),
  );
}
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 255n);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function protocolResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
export function failure(error: unknown): Response {
  if (error instanceof ProtocolError)
    return protocolResponse({ error: { code: error.code } }, error.status);
  console.error(
    JSON.stringify({
      level: "error",
      event: "federation.failure",
      error: String(error),
    }),
  );
  return protocolResponse({ error: { code: "OMEW_INTERNAL" } }, 500);
}
