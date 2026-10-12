// Plain sentences for the API's error codes, so a creator never reads "INVALID_STATE".
import { ApiError } from "./api";

/** `/connect?error=<code>` — set by GET /v1/creator/meta/oauth/callback. */
export const CONNECT_ERRORS: Record<string, string> = {
  denied: "Facebook didn't grant the permissions, so nothing was connected. You can try again whenever you like.",
  expired: "That connection attempt took too long and expired. Please start it again.",
  already_linked:
    "That Facebook account is already connected to another Digital Sukoon Creators account. Sign in to that account instead, or email creators@digitalsukoon.com if you think this is a mistake.",
  app_mismatch: "Facebook answered for a different app than the one we asked. Please start the connection again.",
  exchange_failed: "Facebook didn't finish the connection on its side. Please try again in a moment.",
  disabled: "Connecting pages is paused right now. Please try again later.",
};

export function connectErrorSentence(code: string): string {
  return CONNECT_ERRORS[code] ?? "The connection didn't go through. Please try again.";
}

/** POST /creator/me/submit 409 reasons, and the other codes a signed-in page can meet. */
const CODE_SENTENCES: Record<string, string> = {
  EMAIL_NOT_VERIFIED: "Verify your email address first — use the link we emailed you, or send a new one.",
  NO_PUBLISHABLE_PAGE:
    "Connect at least one Facebook Page or Instagram account that is ready to publish before you send your profile for review.",
  INVALID_STATE: "Your profile is already in review or approved, so there's nothing to send right now.",
  META_NOT_CONFIGURED: "Connecting Facebook isn't available yet. Please try again later.",
  TOO_SOON: "You just did that — try again in a few minutes.",
  WRONG_PASSWORD: "That isn't your current password.",
  EMAIL_EXISTS: "There's already an account with this email. Sign in instead, or reset your password.",
};

export function errorSentence(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    if (err.code && CODE_SENTENCES[err.code]) return CODE_SENTENCES[err.code];
    if (err.status === 429) return "Too many attempts — try again in a few minutes.";
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
