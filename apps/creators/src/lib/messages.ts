// Plain sentences for the API's error codes, so a creator never reads "INVALID_STATE".
import { ApiError } from "./api";

const CONNECT_DENIED = "Facebook didn't grant the permissions, so nothing was connected. You can try again whenever you like.";
const CONNECT_EXPIRED = "That connection attempt took too long and expired. Please start it again.";
const CONNECT_ALREADY_LINKED =
  "That Facebook account is already connected to another Digital Sukoon Creators account. Sign in to that account instead, or email creators@digitalsukoon.com if you think this is a mistake.";
const CONNECT_APP_MISMATCH = "Facebook answered for a different app than the one we asked. Please start the connection again.";
const CONNECT_EXCHANGE_FAILED = "Facebook didn't finish the connection on its side. Please try again in a moment.";
const CONNECT_DISABLED = "Connecting pages is paused right now. Please try again later.";
const CONNECT_WRONG_ACCOUNT =
  "This Facebook connection was started from a different creator account. Sign in to the account you started from, or start the connection again here.";
const CONNECT_STAFF_ACCOUNT =
  "This Facebook account is used by our own team, so it can't be connected as a creator account. Please connect with your own Facebook account.";
const CONNECT_BUSY = "Too many connection attempts right now. Please wait a minute and try again.";

/** `/connect?error=<code>` — set by GET /v1/creator/meta/oauth/callback. */
export const CONNECT_ERRORS: Record<string, string> = {
  denied: CONNECT_DENIED,
  expired: CONNECT_EXPIRED,
  already_linked: CONNECT_ALREADY_LINKED,
  app_mismatch: CONNECT_APP_MISMATCH,
  exchange_failed: CONNECT_EXCHANGE_FAILED,
  disabled: CONNECT_DISABLED,
  wrong_account: CONNECT_WRONG_ACCOUNT,
  staff_account: CONNECT_STAFF_ACCOUNT,
  busy: CONNECT_BUSY,
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
  EMAIL_EXISTS:
    "There's already an account with this email. Sign in instead, or reset your password. If you closed your account, email creators@digitalsukoon.com to reopen it.",
  EMAIL_BUSY: "We can't send emails right now. Please try again in a little while.",
  // The connect flow's errors, when the API answers a request with them (same sentences as ?error=).
  WRONG_ACCOUNT: CONNECT_WRONG_ACCOUNT,
  STAFF_ACCOUNT: CONNECT_STAFF_ACCOUNT,
  ALREADY_LINKED: CONNECT_ALREADY_LINKED,
  APP_MISMATCH: CONNECT_APP_MISMATCH,
  EXCHANGE_FAILED: CONNECT_EXCHANGE_FAILED,
  EXPIRED: CONNECT_EXPIRED,
  DISABLED: CONNECT_DISABLED,
};

export function errorSentence(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    if (err.code && CODE_SENTENCES[err.code]) return CODE_SENTENCES[err.code];
    if (err.status === 429) return "Too many attempts — try again in a few minutes.";
    // Anything else (a 503 we have no sentence for, a validation message) reads as the API wrote it.
    return err.message || fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
