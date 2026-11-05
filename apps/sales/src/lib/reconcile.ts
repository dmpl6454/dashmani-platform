// The reconcile page's words and links (spec-reconcile §7). Shared code is imported BY PATH.
import type { GstStatus, TdsGroup } from "@dashmani/shared/src/sales/recon";
import { fmtInr } from "./format";

/**
 * The "Import old invoices →" link on GST "not in the portal" rows. Set by whichever of PR 3
 * (import) / PR 5 (reconcile) merges second: import is not on this branch's base yet, so null —
 * the import PR flips this one line to "/invoices/import".
 */
export const IMPORT_PAGE: string | null = null;

export const BOOKING_STATUS_TEXT: Record<string, string> = {
  F: "F — final, matched to the deductor's return",
  U: "U — deducted, deposit not matched to the return",
  P: "P — provisional (a government deductor)",
  O: "O — the return claims more than was deposited",
};

export const GST_STATUS_LABEL: Record<GstStatus, string> = {
  matched: "matches", matched_note: "matches", value_mismatch: "differs", wrong_recipient: "wrong GSTIN", wrong_period: "wrong month",
  not_filed: "not filed", not_in_books: "not in portal", cancelled_but_filed: "cancelled here",
};

export const TDS_GROUP_LABEL: Record<TdsGroup, string> = {
  chase: "to chase", link_first: "link first", extra: "more in 26AS", unknown: "unknown", non_sales: "not sales", status_p: "provisional",
  not_due: "not due yet", next_year: "next year", matched: "matches",
};

/** "₹56,200.00 Dr (they owe us)" / "₹40,000.00 Cr (advance from them)". */
export function drCrText(paise: number, long = true): string {
  if (paise === 0) return fmtInr(0);
  return `${fmtInr(Math.abs(paise))} ${paise > 0 ? "Dr" : "Cr"}${long ? (paise > 0 ? " (they owe us)" : " (advance from them)") : ""}`;
}

/** Every SWR key the reconcile actions can change. */
export const reconKey = (key: unknown) => typeof key === "string" && (key.startsWith("/sales/reconcile") || key.startsWith("/sales/clients") || key.startsWith("/sales/events"));
