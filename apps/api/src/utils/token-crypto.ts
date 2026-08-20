/**
 * At-rest encryption for third-party OAuth tokens (Meta Page / user tokens).
 *
 * This is the FIRST at-rest encryption in this repo — a grep for
 * createCipheriv/aes-256/scryptSync returns nothing else. Two login pages already
 * tell users their data is "Encrypted at rest"; this makes that true for the one
 * class of secret we now store.
 *
 * Format:  enc:v1:<b64url(iv,12B)>.<b64url(authTag,16B)>.<b64url(ciphertext)>
 * Cipher:  aes-256-gcm — GCM not CBC, so tampering is DETECTED rather than
 *          decrypted into plausible garbage.
 * Key:     scrypt(META_TOKEN_ENC_KEY, "dashmani-meta-token-v1", 32), derived once
 *          lazily and cached (scrypt is deliberately ~100ms; doing it per call
 *          would make a 90-asset sync spend ~9s on key derivation alone).
 *
 * ⚠️ THERE IS NO FALLBACK KEY, BY DESIGN.
 * An earlier draft fell back to JWT_SECRET. That couples two independent secrets:
 * JWT_SECRET is cheaply rotatable (rotating it just logs everyone out), but if it
 * were also the encryption key, rotating it would silently render every stored
 * token undecryptable — surfacing hours later as GCM auth-tag failures inside a
 * cron, long after the cause. Absent key ⇒ the Meta feature stays dark and no
 * token is ever written. That is the safe failure.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce — the GCM-recommended size
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Fixed salt: the key material itself is the secret, and a stable salt keeps
 *  decryption possible across restarts without storing a per-value salt. */
const SCRYPT_SALT = "dashmani-meta-token-v1";

/** Thrown when a stored value is not in our envelope format. */
export class SecretFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretFormatError";
  }
}

let cachedKey: Buffer | null = null;

function rawKey(): string {
  return (process.env.META_TOKEN_ENC_KEY ?? "").trim();
}

/** True when a usable encryption key is configured. No fallback is consulted. */
export function tokenCryptoConfigured(): boolean {
  return rawKey().length > 0;
}

/**
 * Called from metaOauthConfigured() — deliberately NOT at import time, so tests
 * and unrelated code can import this module on a box with no key configured.
 */
export function assertTokenCryptoReady(): void {
  if (!tokenCryptoConfigured()) {
    throw new Error(
      "META_TOKEN_ENC_KEY is not set. Meta OAuth is disabled: refusing to store a " +
        "third-party access token in plaintext. Generate one with `openssl rand -base64 48`.",
    );
  }
}

function key(): Buffer {
  if (cachedKey) return cachedKey;
  assertTokenCryptoReady();
  cachedKey = scryptSync(rawKey(), SCRYPT_SALT, KEY_BYTES);
  return cachedKey;
}

/** Test-only: drop the cached key so a test can swap META_TOKEN_ENC_KEY. */
export function __resetKeyCacheForTesting(): void {
  cachedKey = null;
}

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** Encrypt a token for storage. Returns the full `enc:v1:…` envelope. */
export function encryptToken(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new SecretFormatError("refusing to encrypt an empty token");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
}

/**
 * Decrypt a stored token.
 *
 * ⚠️ Throws SecretFormatError on anything lacking the `enc:v1:` prefix — it does
 * NOT pass the value through as plaintext. A silent passthrough would mean a
 * mis-migrated plaintext row keeps working, and the whole mechanism becomes
 * decorative. Fail loudly instead; the recovery path is one Reconnect click.
 */
export function decryptToken(stored: string): string {
  if (typeof stored !== "string" || !stored.startsWith(PREFIX)) {
    throw new SecretFormatError(
      "stored secret is not in enc:v1 format — refusing to treat it as plaintext",
    );
  }
  const parts = stored.slice(PREFIX.length).split(".");
  if (parts.length !== 3) {
    throw new SecretFormatError("malformed enc:v1 envelope (expected 3 segments)");
  }
  const [ivS, tagS, ctS] = parts;
  const iv = unb64u(ivS);
  const tag = unb64u(tagS);
  if (iv.length !== IV_BYTES) throw new SecretFormatError("bad iv length");
  if (tag.length !== TAG_BYTES) throw new SecretFormatError("bad auth tag length");
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  // .final() throws on tag mismatch — that IS the tamper/wrong-key detection.
  return Buffer.concat([decipher.update(unb64u(ctS)), decipher.final()]).toString("utf8");
}

/** Safe placeholder for logs/UI. Never returns any ciphertext bytes. */
export function redactToken(value: string | null | undefined): string {
  if (!value) return "(none)";
  return "enc:v1:…(redacted)";
}

/**
 * Strip secrets out of any string before it is logged or persisted to
 * MetaConnection.lastError.
 *
 * ⚠️ Required because index.ts console.errors raw rejection reasons and there is
 * no redaction helper anywhere else in apps/api/src. A Graph error body routinely
 * echoes the full request URL — including access_token= — so an unscrubbed
 * lastError would put a live Page token in the DB and in the admin UI.
 */
export function scrubSecrets(input: string): string {
  if (!input) return "";
  let s = String(input);
  // Query/body params carrying secrets.
  s = s.replace(
    /\b(access_token|client_secret|fb_exchange_token|input_token|appsecret_proof|code|token)=([^&\s"'}\]]+)/gi,
    "$1=[REDACTED]",
  );
  // JSON-ish "access_token":"…"
  s = s.replace(
    /"(access_token|client_secret|fb_exchange_token|input_token|appsecret_proof)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"',
  );
  // Our own envelope, if it ever lands in a message.
  s = s.replace(/enc:v1:[A-Za-z0-9_\-.]+/g, "enc:v1:[REDACTED]");
  // Meta tokens are long opaque strings that commonly start EAA.
  s = s.replace(/\bEAA[A-Za-z0-9_\-]{20,}/g, "[REDACTED_TOKEN]");
  // App-token form "<appId>|<secret>".
  s = s.replace(/\b\d{15,17}\|[A-Za-z0-9_\-]{10,}/g, "[REDACTED_APP_TOKEN]");
  return s;
}
