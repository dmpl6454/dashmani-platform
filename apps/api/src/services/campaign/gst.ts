import { computeTotals, DEFAULT_COMPANY, type TaxMode } from "@dashmani/shared";
import { resolveDocumentTax } from "../sales/documents.service";

// GST on a campaign booking (owner decision, 2026-10-27: charged on top of the rate-card prices at
// checkout). Worked out exactly as the booking's tax invoice works it out — the same seller
// profile, the client's billing state, one GST computation over all the lines and the same rupee
// rounding — so the amount the client pays equals the invoice total to the paisa.

export interface CampaignPricing {
  subtotalPaise: number;
  gstRateBp: number;
  taxMode: TaxMode;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

export async function campaignPricing(clientId: string, itemPrices: number[]): Promise<CampaignPricing> {
  const tax = await resolveDocumentTax(clientId, {}, DEFAULT_COMPANY);
  const t = computeTotals({
    lines: itemPrices.map((p) => ({ quantity: 1, unitPricePaise: p, discountPaise: 0 })),
    taxMode: tax.taxMode,
    gstRateBp: tax.gstRateBp,
    roundToRupee: tax.seller.roundToRupee,
  });
  return {
    subtotalPaise: t.subtotalPaise,
    gstRateBp: tax.gstRateBp,
    taxMode: tax.taxMode,
    cgstPaise: t.cgstPaise,
    sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise,
    gstPaise: t.taxPaise,
    roundOffPaise: t.roundOffPaise,
    totalPaise: t.totalPaise,
  };
}

/** The GST that went with one item's price (for refunding a single post), from the frozen checkout pricing. */
export function itemGstPaise(pricePaise: number, pricing: Pick<CampaignPricing, "taxMode" | "gstRateBp"> | null | undefined): number {
  if (!pricing || pricing.taxMode === "none") return 0;
  return Math.round((pricePaise * pricing.gstRateBp) / 10_000);
}

/** The checkout pricing frozen in a booking's pricingSnapshot (null for one paid before GST was charged). */
export function snapshotPricing(snapshot: unknown): CampaignPricing | null {
  const g = (snapshot as { gst?: CampaignPricing } | null)?.gst;
  return g && typeof g.totalPaise === "number" ? g : null;
}
