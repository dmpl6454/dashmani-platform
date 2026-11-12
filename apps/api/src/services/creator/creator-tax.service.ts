/**
 * How a creator is paid (owner decision 2026-11-12, G72; payer = Digital Sukoon Private Limited, G74).
 *
 *  - GST registered → the creator gives their GSTIN, invoices us with GST, and we pay their price + GST.
 *  - Not registered → the creator gives their PAN, and TDS is deducted from the payout.
 *
 * Stored in the creators table's reserved payout columns (no schema change):
 *   payout_method      = "gst" | "pan"
 *   payout_currency    = "INR"
 *   payout_details_enc = encrypted JSON { route, gstin?, pan, legalName } (token-crypto, META_TOKEN_ENC_KEY)
 *   payout_details_hint= "GSTIN ••••1Z5" | "PAN ••••34F"
 * ⚠️ The full numbers are never returned to the creator portal (only the hint) — staff read them on
 * the internal creator page, behind the admin gate.
 */
import { prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { decryptToken, encryptToken, tokenCryptoConfigured } from "../../utils/token-crypto";

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export type CreatorTaxRoute = "gst" | "pan";
export type CreatorTaxInput = { route: CreatorTaxRoute; gstin?: string; pan?: string; legalName: string };
export type CreatorTaxDetails = { route: CreatorTaxRoute; gstin: string | null; pan: string; legalName: string };

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();

export function hintFor(d: CreatorTaxDetails): string {
  return d.route === "gst" ? `GSTIN ••••${d.gstin!.slice(-3)}` : `PAN ••••${d.pan.slice(-3)}`;
}

/** Validate and normalise. A GSTIN carries the PAN in characters 3–12, so the PAN is derived from it. */
export function parseCreatorTax(input: CreatorTaxInput): CreatorTaxDetails {
  const legalName = (input.legalName ?? "").replace(/<[^>]*>/g, "").trim();
  if (legalName.length < 2 || legalName.length > 120) {
    throw new AppError(400, "INVALID_NAME", "Enter the name exactly as it appears on your GST certificate or PAN card.");
  }
  if (input.route === "gst") {
    const gstin = clean(input.gstin);
    if (!GSTIN_RE.test(gstin)) throw new AppError(400, "INVALID_GSTIN", "That GSTIN doesn't look right — it is 15 characters, like 27ABCDE1234F1Z5.");
    return { route: "gst", gstin, pan: gstin.slice(2, 12), legalName };
  }
  if (input.route === "pan") {
    const pan = clean(input.pan);
    if (!PAN_RE.test(pan)) throw new AppError(400, "INVALID_PAN", "That PAN doesn't look right — it is 10 characters, like ABCDE1234F.");
    return { route: "pan", gstin: null, pan, legalName };
  }
  throw new AppError(400, "INVALID_ROUTE", "Choose whether you are GST registered.");
}

export function readCreatorTax(c: { payoutDetailsEnc: string | null }): CreatorTaxDetails | null {
  if (!c.payoutDetailsEnc) return null;
  try {
    return JSON.parse(decryptToken(c.payoutDetailsEnc)) as CreatorTaxDetails;
  } catch (e) {
    console.error("[creator-tax] could not decrypt payout details", e instanceof Error ? e.message : e);
    return null;
  }
}

/** What the creator portal shows: the route and a masked hint, never the full number. */
export function taxSummary(c: { payoutMethod: string | null; payoutDetailsHint: string | null; payoutDetailsEnc: string | null }) {
  if (!c.payoutDetailsEnc || (c.payoutMethod !== "gst" && c.payoutMethod !== "pan")) return null;
  return { route: c.payoutMethod as CreatorTaxRoute, hint: c.payoutDetailsHint };
}

export async function setCreatorTax(creatorId: string, input: CreatorTaxInput) {
  if (!tokenCryptoConfigured()) {
    throw new AppError(503, "TAX_DETAILS_OFF", "We can't save tax details right now. Write to creators@digitalsukoon.com.");
  }
  const details = parseCreatorTax(input);
  const c = await prisma.creator.update({
    where: { id: creatorId },
    data: {
      payoutMethod: details.route,
      payoutCurrency: "INR",
      payoutDetailsEnc: encryptToken(JSON.stringify(details)),
      payoutDetailsHint: hintFor(details),
    },
    select: { payoutMethod: true, payoutDetailsHint: true, payoutDetailsEnc: true },
  });
  return taxSummary(c);
}
