import crypto from "crypto";

// Short-lived signed URLs for campaign media previews.
//
// A <video>/<img> tag cannot send the portal's Authorization header, and loading a 500 MB video
// into a blob is not an option, so the authenticated API hands out a URL that is valid for a
// limited time: /v1/campaign-media/:id/:variant?exp=<unix>&sig=<hmac>. The file itself stays
// outside /uploads and is only ever served through this check.

function key(): string {
  // Same fallback as utils/jwt.ts (prod always sets JWT_SECRET).
  const base = process.env.CAMPAIGN_MEDIA_URL_SECRET || process.env.JWT_SECRET || "dev-secret";
  // Domain-separated so a media signature can never be confused with anything else.
  return crypto.createHmac("sha256", base).update("campaign-media-url:v1").digest("hex");
}

export type MediaVariant = "preview" | "original";

function sign(id: string, variant: MediaVariant, exp: number): string {
  return crypto.createHmac("sha256", key()).update(`${id}|${variant}|${exp}`).digest("base64url");
}

export function signedMediaPath(id: string, variant: MediaVariant, ttlSec = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `/v1/campaign-media/${id}/${variant}?exp=${exp}&sig=${sign(id, variant, exp)}`;
}

export function verifyMediaSignature(id: string, variant: string, exp: string | undefined, sig: string | undefined): boolean {
  if (variant !== "preview" && variant !== "original") return false;
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000) || !sig) return false;
  const expected = Buffer.from(sign(id, variant, e));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
