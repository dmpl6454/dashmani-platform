// Plain sentences for the API's error codes, so staff never read "INVALID_CREDENTIALS".
import { ApiError } from "./api";

const CODES: Record<string, string> = {
  INVALID_CREDENTIALS: "That email and password don't match.",
  ACCOUNT_INACTIVE: "This account is not active. Ask an admin on the staff portal.",
  FORBIDDEN: "Your account doesn't have the Sales role for this action.",
  SELLER_PROFILE_INCOMPLETE: "Complete the company GST profile in Settings before issuing a tax invoice.",
  QUOTE_LOCKED: "This quote can no longer be edited.",
  ORDER_LOCKED: "This order can no longer be edited.",
  INVOICE_SETTLED: "This invoice has payments or credit notes against it — use a credit note instead of cancelling.",
  OVER_ALLOCATED: "That is more than the invoice has outstanding.",
  OVER_CREDITED: "That is more than can still be credited on this invoice.",
  EMAIL_EXISTS: "This email already belongs to a client or one of their portal logins. Use another email, or pick that client.",
  BAD_TRANSITION: "That action isn't available in the document's current state.",
  NETWORK: "Couldn't reach the server — check your connection and try again.",
  // Smart invoicing (spec-00 §2.11–2.12). BANK_BUSY is mandatory: without it every 429 reads
  // "Too many attempts". INVOICE_LOCKED is deliberately NOT here — the server says why (a receipt
  // or credit note on it, "Imported from Swipe — …"), and an override would hide that. Codes two
  // features both emit (FILE_TOO_LARGE, NO_FILE, INVALID_UPLOAD, …) are never overridden either:
  // each server message is already that feature's sentence. Features add no CODES.
  BANK_BUSY: "Another statement is being read — try again in a few seconds",
  BANK_OFF: "Bank statement matching is switched off on this server",
  IMPORT_OFF: "Importing old invoices is switched off on the server right now",
  PLAN_CHANGED: "Someone changed the columns, clients or invoices after you loaded this check. The new check is below — look at it and press Import again.",
};

/** The sentence to show for any thrown error, with a fallback for the unknown. */
export function errorSentence(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    if (err.code && CODES[err.code]) return CODES[err.code];
    if (err.status === 429) return "Too many attempts — try again in a few minutes.";
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
