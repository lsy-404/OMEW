// Client-side ownership key: an Ed25519 keypair generated in the browser at
// registration time. The private key never leaves the client in plaintext —
// it's encrypted with a key the user's ownership passphrase derives, and only
// the public key + the encrypted envelope are sent to the server.
//
// Envelope format (JSON, sent as the `ownership_ciphertext` string):
//   v            envelope version, currently 1
//   kdf          "argon2id"
//   kdfParams    { t, m (KiB), p, dkLen } passed to argon2id
//   salt         base64, 16 random bytes, unique per key
//   cipher       "AES-256-GCM"
//   nonce        base64, 12 random bytes (AES-GCM IV)
//   ciphertext   base64, AES-GCM(secretKey) with the auth tag appended
//
// KDF params (t:2, m:19456 KiB, p:1) are OWASP's argon2id "low-memory"
// recommendation — chosen because this runs synchronously-ish in the
// browser's main thread and needs to stay under ~1s, not because memory is
// actually constrained.
import { ed25519 } from '@noble/curves/ed25519.js'
import { argon2idAsync } from '@noble/hashes/argon2.js'
import { randomBytes } from '@noble/hashes/utils.js'

const KDF_PARAMS = { t: 2, m: 19456, p: 1, dkLen: 32 } as const

export interface OwnershipEnvelope {
  v: 1
  kdf: 'argon2id'
  kdfParams: typeof KDF_PARAMS
  salt: string
  cipher: 'AES-256-GCM'
  nonce: string
  ciphertext: string
}

export interface OwnershipKeyResult {
  pubkeyBase64: string
  envelope: OwnershipEnvelope
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function encryptSecretKey(secretKey: Uint8Array<ArrayBuffer>, passphrase: string): Promise<OwnershipEnvelope> {
  const salt = randomBytes(16)
  const derived = await argon2idAsync(passphrase, salt, KDF_PARAMS)
  const aesKey = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['encrypt'])
  const nonce = randomBytes(12)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, secretKey)

  return {
    v: 1,
    kdf: 'argon2id',
    kdfParams: KDF_PARAMS,
    salt: toBase64(salt),
    cipher: 'AES-256-GCM',
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  }
}

export async function generateOwnershipKey(passphrase: string): Promise<OwnershipKeyResult> {
  const { secretKey, publicKey } = ed25519.keygen()
  const envelope = await encryptSecretKey(secretKey, passphrase)
  return { pubkeyBase64: toBase64(publicKey), envelope }
}

export function envelopeToCiphertextField(envelope: OwnershipEnvelope): string {
  return JSON.stringify(envelope)
}

export function parseOwnershipEnvelope(field: string): OwnershipEnvelope {
  const parsed = JSON.parse(field)
  if (parsed?.v !== 1 || parsed?.kdf !== 'argon2id' || typeof parsed?.salt !== 'string' || typeof parsed?.nonce !== 'string' || typeof parsed?.ciphertext !== 'string') {
    throw new Error('malformed ownership envelope')
  }
  if (parsed.cipher !== 'AES-256-GCM' ||
      Object.entries(KDF_PARAMS).some(([key, value]) => parsed.kdfParams?.[key] !== value) ||
      fromBase64(parsed.salt).length !== 16 || fromBase64(parsed.nonce).length !== 12 || fromBase64(parsed.ciphertext).length !== 48) {
    throw new Error('unsupported ownership envelope')
  }
  return parsed as OwnershipEnvelope
}

// Decrypts the stored envelope with `passphrase`, returning the raw secret key
// bytes on success or null if the passphrase doesn't unlock it (AES-GCM auth
// tag mismatch) — the caller can't distinguish "wrong passphrase" from
// "independent ownership passphrase, not the login password" and shouldn't
// need to: both mean "don't reseal."
export async function unsealOwnershipKey(passphrase: string, envelope: OwnershipEnvelope): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const salt = fromBase64(envelope.salt)
    const derived = await argon2idAsync(passphrase, salt, envelope.kdfParams)
    const aesKey = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['decrypt'])
    const nonce = fromBase64(envelope.nonce)
    const ciphertext = fromBase64(envelope.ciphertext)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext)
    return new Uint8Array(decrypted)
  } catch {
    return null
  }
}

// Re-encrypts an already-unsealed secret key under a new passphrase — used by
// the change-password flow (m0-protocol §7.9a) to re-wrap the custody
// ciphertext when the login password itself is the custody passphrase. The
// keypair (and its public key) is unchanged; only the envelope is replaced.
export async function resealOwnershipKey(secretKey: Uint8Array<ArrayBuffer>, passphrase: string): Promise<OwnershipEnvelope> {
  return encryptSecretKey(secretKey, passphrase)
}

export function downloadOwnershipBackup(pubkeyBase64: string, envelope: OwnershipEnvelope, username: string) {
  const payload = { pubkey: pubkeyBase64, ...envelope }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `openmew-ownership-key-${username}.json`
  link.click()
  URL.revokeObjectURL(url)
}
