"use client";
import { mutate } from "swr";

/** After any Tally mutation: refetch every /sales/tally* key (previews, runs, parties, document badges). */
export const refreshTally = () => mutate((k) => typeof k === "string" && k.startsWith("/sales/tally"), undefined, { revalidate: true });

/** Where a Tally document's number links: credit notes open their invoice, refunds their receipt. */
export const docHref = (d: { docType: string; docId: string; parentId?: string | null }) =>
  d.docType === "invoice" ? `/invoices/view?id=${d.docId}` : d.docType === "receipt" ? `/payments/view?id=${d.docId}`
    : d.docType === "credit_note" && d.parentId ? `/invoices/view?id=${d.parentId}` : d.docType === "refund" && d.parentId ? `/payments/view?id=${d.parentId}` : null;
