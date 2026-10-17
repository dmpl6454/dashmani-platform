// Plain sentences for the API's error codes, so a creator never reads "INVALID_STATE".
import { ApiError } from "./api";
import { PAYOUT_FIELD_REJECTED, PAYOUT_FORM_FIELDS, type PayoutFormField } from "@dashmani/shared/src/validators/creator-payout";

const CONNECT_DENIED = "Facebook didn't grant the permissions, so nothing was connected. You can try again whenever you like.";
const CONNECT_EXPIRED = "That connection attempt took too long and expired. Please start it again.";
const CONNECT_ALREADY_LINKED =
  "That Facebook account is already connected to another Digital Sukoon Creators account. Sign in to that account instead, or email creators@digitalsukoon.com if you think this is a mistake.";
const CONNECT_APP_MISMATCH = "Facebook answered for a different app than the one we asked. Please start the connection again.";
const CONNECT_EXCHANGE_FAILED = "Facebook didn't finish the connection on its side. Please try again in a moment.";
const CONNECT_DISABLED = "Connecting pages is paused right now. Please try again later.";
const CONNECT_WRONG_ACCOUNT =
  "This Facebook connection was started from a different creator account, so nothing was saved. If this is the account you want to connect, press Connect Facebook here and approve it again. If you didn't start it, someone may have sent you their link — you can ignore it.";
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

// ── Bank connect (payouts) ──────────────────────────────────────────────────────────────────────
// ⚠️ PRIVACY. A bank-connect request carries a PAN, a bank account number, an IFSC, a name and an
// address. None of the sentences below is ever the API's own message, because an API error could in
// principle quote a value; each is OURS, picked by error code. The only API text that is passed on is
// the two fixed strings apiFetch itself writes for "no connection" and "not JSON" (they carry no input).

const PAYOUT_SENTENCES: Record<string, string> = {
  VALIDATION_ERROR: "Some details didn't pass our check. Please look at the fields marked below.",
  PAN_REJECTED:
    "Razorpay didn't accept the PAN. Check that it is your personal PAN, exactly as printed on the card, and that your name matches it.",
  BANK_DETAILS_REJECTED:
    "Razorpay didn't accept the bank details. Check the account number and the IFSC code, and that the account is in the same name as your PAN.",
  DETAILS_REJECTED: "Razorpay didn't accept some of the details. Check the fields marked below and send them again.",
  ACCOUNT_CONFLICT:
    "We couldn't link a payout account to your profile. Our team has been told; if you don't hear from us, email creators@digitalsukoon.com.",
  SETUP_UNCERTAIN:
    "We couldn't confirm whether Razorpay finished setting up your payout account. Nothing has been lost. Please try again in a minute; if it keeps happening, email creators@digitalsukoon.com.",
  // A refusal only our team can resolve (Razorpay turned down the Route product request, which carries none of the
  // creator's details): retyping cannot help and would only spend attempts, so the sentence says so.
  SETUP_NEEDS_TEAM: "Our team has been told and will finish this. There is no need to try again; we will email you.",
  SETUP_IN_PROGRESS: "Your bank account is already being set up, perhaps in another tab. Give it a minute, then check this page.",
  RAZORPAY_UNAVAILABLE: "Razorpay didn't answer. Nothing has been lost. Please try again in a minute.",
  PAYOUT_BUSY: "We're setting up a lot of payout accounts right now. Please try again tomorrow.",
  PAYOUT_UNAVAILABLE: "Adding a bank account is temporarily unavailable. Our team has been told. Please try again later.",
  ROUTE_DISABLED: "Adding a bank account isn't open right now.",
  // The same answer as ROUTE_DISABLED for the creator: bank connect is not open yet. (The page never offers the form then.)
  TERMS_PENDING: "Adding a bank account isn't open yet.",
  // Razorpay already holds this payout account past setup, so nothing is sent again. ⚠️ No "Change bank account": this
  // answer comes while our own record of the setup is still short of finished, and the page offers that button only once
  // it is finished. The one way out that always exists is the email address.
  ALREADY_SET_UP:
    "Your payout account is already set up with Razorpay, so nothing needs to be sent again. If you need to change your bank account, email creators@digitalsukoon.com.",
  TERMS_CHANGED: "The creator terms have changed. Reload this page, read them and accept again.",
  NOT_APPROVED: "Your profile needs to be approved before you can add a bank account.",
  ACCOUNT_SUSPENDED: "Your account is suspended, so a bank account can't be added right now. Email creators@digitalsukoon.com.",
  EMAIL_NOT_VERIFIED: CODE_SENTENCES.EMAIL_NOT_VERIFIED,
  NO_PAYOUT_ACCOUNT: "Add your bank account first.",
  RATE_LIMIT: "Too many attempts. Please try again in an hour.",
};

/**
 * The sentence for a failed payout call. Never `err.message` from the API; unknown codes get a plain
 * generic line. (errorSentence above falls back to the API's text, which is right for most pages and
 * wrong for this one.)
 */
export function payoutErrorSentence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "NETWORK" || err.code === "BAD_RESPONSE") return err.message; // fixed client-side strings
    if (err.code && PAYOUT_SENTENCES[err.code]) return PAYOUT_SENTENCES[err.code];
    if (err.status === 429) return PAYOUT_SENTENCES.RATE_LIMIT;
  }
  return "Something went wrong. Please try again.";
}

/**
 * Codes after which the server gave a DEFINITE answer to what was sent: the form's PAN and bank fields
 * are cleared and typed again. After an uncertain outcome (no connection, a 5xx, a busy or in-progress
 * answer, an unknown setup result) they are KEPT so the same press of the button can be repeated.
 */
const PAYOUT_DEFINITE_CODES: ReadonlySet<string> = new Set([
  "VALIDATION_ERROR",
  "PAN_REJECTED",
  "BANK_DETAILS_REJECTED",
  "DETAILS_REJECTED",
  "ACCOUNT_CONFLICT",
  "SETUP_NEEDS_TEAM",
  "TERMS_CHANGED",
  "NOT_APPROVED",
  "ACCOUNT_SUSPENDED",
  "EMAIL_NOT_VERIFIED",
  "ROUTE_DISABLED",
  "TERMS_PENDING",
  "ALREADY_SET_UP",
  "NO_PAYOUT_ACCOUNT",
]);

export function payoutFailureIsDefinite(err: unknown): boolean {
  return err instanceof ApiError && !!err.code && PAYOUT_DEFINITE_CODES.has(err.code);
}

/** Codes whose `details` name the form fields Razorpay refused (our wording for each comes from the shared list). */
const PAYOUT_REJECTION_CODES: ReadonlySet<string> = new Set(["PAN_REJECTED", "BANK_DETAILS_REJECTED", "DETAILS_REJECTED"]);

/**
 * The form fields an error names, each with a sentence of ours: for a rejection the shared "Razorpay
 * did not accept this ..." line, for a failed server check a plain "Check this detail". Only names in the
 * form's own field list are accepted, and the API's per-field message is never read.
 */
export function payoutErrorFields(err: unknown): Array<{ field: PayoutFormField; message: string }> {
  if (!(err instanceof ApiError) || !err.code || !Array.isArray(err.details)) return [];
  const rejection = PAYOUT_REJECTION_CODES.has(err.code);
  if (!rejection && err.code !== "VALIDATION_ERROR") return [];
  const known: ReadonlyArray<string> = PAYOUT_FORM_FIELDS;
  const out: Array<{ field: PayoutFormField; message: string }> = [];
  for (const d of err.details) {
    const f = typeof d?.field === "string" ? d.field : "";
    if (!known.includes(f) || out.some((o) => o.field === f)) continue;
    out.push({ field: f as PayoutFormField, message: rejection ? PAYOUT_FIELD_REJECTED[f as PayoutFormField] : "Check this detail" });
  }
  return out;
}
