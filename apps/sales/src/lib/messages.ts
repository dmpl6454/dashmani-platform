// Plain sentences for the API's error codes, so staff never read "INVALID_CREDENTIALS".
import { ApiError } from "./api";

const CODES: Record<string, string> = {
  INVALID_CREDENTIALS: "That email and password don't match.",
  ACCOUNT_INACTIVE: "This account is not active. Ask an admin on the staff portal.",
  FORBIDDEN: "Your account doesn't have the Sales role for this action.",
  SELLER_PROFILE_INCOMPLETE: "Complete the company GST profile in Settings before issuing a tax invoice.",
  QUOTE_LOCKED: "This quote can no longer be edited.",
  ORDER_LOCKED: "This order can no longer be edited.",
  INVOICE_LOCKED: "An issued invoice can't be edited — cancel it and issue a new one, or add a credit note.",
  INVOICE_SETTLED: "This invoice has payments or credit notes against it — use a credit note instead of cancelling.",
  OVER_ALLOCATED: "That is more than the invoice has outstanding.",
  OVER_CREDITED: "That is more than can still be credited on this invoice.",
  EMAIL_EXISTS: "A client with this email already exists.",
  BAD_TRANSITION: "That action isn't available in the document's current state.",
  NETWORK: "Couldn't reach the server — check your connection and try again.",
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
