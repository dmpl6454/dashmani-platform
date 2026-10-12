/**
 * Meta `signed_request` parsing — the body of the Deauthorize and Data Deletion callbacks.
 *
 * Format: `<base64url(HMAC-SHA256(payloadPart, appSecret))>.<base64url(JSON payload)>`.
 * The HMAC is computed over the ENCODED payload part exactly as received, and the payload must
 * declare `"algorithm": "HMAC-SHA256"` (anything else is refused — never downgrade).
 * Constant-time comparison; never throws; returns null for anything that does not verify.
 */

import { createHmac, timingSafeEqual } from "crypto";

export interface SignedRequestPayload {
  algorithm: string;
  user_id?: string;
  issued_at?: number;
  [k: string]: unknown;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function parseSignedRequest(signedRequest: unknown, appSecret: string): SignedRequestPayload | null {
  if (typeof signedRequest !== "string" || !appSecret) return null;
  // Real ones are a few hundred bytes; bound the work an anonymous caller can ask for.
  if (signedRequest.length === 0 || signedRequest.length > 8192) return null;
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [sigPart, payloadPart] = parts;
  if (!sigPart || !payloadPart || !B64URL.test(sigPart) || !B64URL.test(payloadPart)) return null;

  let payload: SignedRequestPayload;
  try {
    const parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as SignedRequestPayload;
  } catch {
    return null;
  }
  if (typeof payload.algorithm !== "string" || payload.algorithm.toUpperCase() !== "HMAC-SHA256") return null;

  const given = Buffer.from(sigPart, "base64url");
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return payload;
}

/** Build one (tests, and any future local tooling). */
export function signRequestForTesting(payload: Record<string, unknown>, appSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", appSecret).update(body).digest("base64url");
  return `${sig}.${body}`;
}
