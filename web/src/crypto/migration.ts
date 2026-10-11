import canonicalize from "canonicalize";
import { ed25519 } from "@noble/curves/ed25519.js";
export function urlBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const bytes = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}
export async function ownershipId(
  seed: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return urlBase64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", ed25519.getPublicKey(seed)),
    ).slice(0, 16),
  );
}
export async function migrationProof(
  seed: Uint8Array<ArrayBuffer>,
  oldActor: string,
  newActor: string,
  challenge: { nonce: string; challenge_origin: string },
  history: unknown[],
  release?: unknown,
): Promise<Record<string, unknown>> {
  const claim = {
    old: oldActor,
    new: newActor,
    nonce: challenge.nonce,
    challenge_origin: challenge.challenge_origin,
    signed_at: Date.now(),
  };
  const bytes = new TextEncoder().encode(
    `openmew/migration-claim/v1\0${canonicalize(claim)}`,
  );
  return {
    ...claim,
    ownership_key_id: await ownershipId(seed),
    key_history: history,
    sig: urlBase64(ed25519.sign(bytes, seed)),
    ...(release ? { home_release: release } : {}),
  };
}
