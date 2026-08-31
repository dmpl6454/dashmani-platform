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

export function verifyRefreshToken(token: string): { userId: string; remember?: boolean } {
  return jwt.verify(token, JWT_REFRESH_SECRET) as { userId: string; remember?: boolean };
}
