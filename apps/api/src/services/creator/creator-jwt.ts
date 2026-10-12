import crypto from "crypto";
import jwt from "jsonwebtoken";
import { AppError } from "../../middleware/error-handler";

// Creator sessions are signed with THEIR OWN secrets and carry `aud: "creators"`.
// ⚠️ Why not JWT_SECRET: `authenticate` (staff) checks the signature alone, and every other
// portal signs with JWT_SECRET — a creator token signed the same way would pass staff gates that
// forget a type check (the /admin/ai/assist hole closed on 2026-10-12). With a separate secret a
// creator token is simply invalid everywhere but the creator routes, and vice versa.
// In production a missing secret is a 503, never a fallback.

export const CREATOR_ACCESS_TTL = "1h";
export const CREATOR_REFRESH_TTL_DAYS = 30;
const AUD = "creators";

function secret(kind: "access" | "refresh"): string {
  const v = kind === "access" ? process.env.CREATOR_JWT_SECRET : process.env.CREATOR_JWT_REFRESH_SECRET;
  if (v) return v;
  if (process.env.NODE_ENV === "production") {
    throw new AppError(503, "CREATORS_NOT_CONFIGURED", "The creator portal is not configured yet.");
  }
  return `dev-only-creator-${kind}-secret`;
}

export function creatorSecretsConfigured(): boolean {
  return Boolean(process.env.CREATOR_JWT_SECRET && process.env.CREATOR_JWT_REFRESH_SECRET);
}

export interface CreatorAccessPayload {
  creatorId: string;
  email: string;
  type: "creator";
}

export function signCreatorAccessToken(p: { creatorId: string; email: string }): string {
  return jwt.sign({ creatorId: p.creatorId, email: p.email, type: "creator" }, secret("access"), {
    expiresIn: CREATOR_ACCESS_TTL,
    audience: AUD,
  });
}

/** ⚠️ The jwtid nonce is load-bearing: two tokens minted in the same second must not collide on
 *  creator_refresh_tokens.token_hash UNIQUE. */
export function signCreatorRefreshToken(creatorId: string): string {
  return jwt.sign({ creatorId, type: "creator-refresh" }, secret("refresh"), {
    expiresIn: `${CREATOR_REFRESH_TTL_DAYS}d`,
    audience: AUD,
    jwtid: crypto.randomUUID(),
  });
}

/** Throws on a bad signature, wrong audience, expiry or a non-creator token. */
export function verifyCreatorAccessToken(token: string): CreatorAccessPayload {
  const p = jwt.verify(token, secret("access"), { audience: AUD }) as Partial<CreatorAccessPayload>;
  if (p.type !== "creator" || !p.creatorId) throw new Error("not a creator access token");
  return { creatorId: p.creatorId, email: p.email ?? "", type: "creator" };
}

export function verifyCreatorRefreshToken(token: string): { creatorId: string } {
  const p = jwt.verify(token, secret("refresh"), { audience: AUD }) as { creatorId?: string; type?: string };
  if (p.type !== "creator-refresh" || !p.creatorId) throw new Error("not a creator refresh token");
  return { creatorId: p.creatorId };
}

/** SHA-256 of an opaque token (refresh tokens, emailed tokens) — only the hash is stored. */
export function hashToken(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}
