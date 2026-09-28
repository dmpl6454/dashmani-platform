import jwt from "jsonwebtoken";
import crypto from "crypto";
import type { JwtPayload } from "@dashmani/shared";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret";

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "4h" });
}

/** How long a refresh token lives. "Keep me signed in" stretches 7d to 30d. */
export const REFRESH_TTL_DAYS = 7;
export const REMEMBER_TTL_DAYS = 30;

/**
 * ⚠️ The jwtid (a UUID nonce) is load-bearing — two tokens issued in the same
 * second for the same user would otherwise collide on refresh_tokens.token
 * UNIQUE. Do not remove it.
 *
 * `remember` rides inside the token so ROTATION can preserve the choice: a
 * 30d "keep me signed in" session must not silently shrink back to 7d on its
 * first refresh. Omitted entirely for normal sessions, so existing tokens and
 * every other caller (client/hr/acceptInvite) are byte-compatible.
 */
export function signRefreshToken(payload: { userId: string; remember?: boolean }): string {
  const days = payload.remember ? REMEMBER_TTL_DAYS : REFRESH_TTL_DAYS;
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: `${days}d`, jwtid: crypto.randomUUID() });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

/**
 * Signature check ONLY (expiry ignored). For rate-limit KEYING, never for authentication:
 * the pipeline limiter keys an expired-but-genuine token by its user so the request
 * reaches `authenticate`, gets its 401 and the client refreshes — instead of being keyed
 * on the shared Cloudflare edge IP and 429'd first (spec §3.1). A forged token still
 * throws here.
 */
export function verifyAccessTokenSignature(token: string): Partial<JwtPayload> {
  return jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as Partial<JwtPayload>;
}

export function verifyRefreshToken(token: string): { userId: string; remember?: boolean } {
  return jwt.verify(token, JWT_REFRESH_SECRET) as { userId: string; remember?: boolean };
}
