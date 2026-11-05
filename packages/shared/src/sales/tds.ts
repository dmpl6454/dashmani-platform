// TDS rules shared by the smart-invoicing features (spec-00 §2.7): import's sense checks, bank's
// proposals and chips, and the accounts page's rate check. Pure — no I/O, no Date. Money in paise.
//
// Clients deduct TDS on OUR invoices (we are the payee): 194C (advertising contracts) 1% / 2%,
// 194J (professional / technical) 10% (2% for technical services). These are HINTS only — the
// portal never blocks or changes a receipt because a rate looks unusual. Barrel rule: every name
// here is exported by this module only; validators import TDS_SECTIONS from here, never re-export it.

export const TDS_SECTIONS = ["194C", "194J", "194H", "other"] as const;
export type TdsSection = (typeof TDS_SECTIONS)[number];

/** ±₹1: clients round TDS to the rupee. */
export const TDS_TOLERANCE_PAISE = 100;

export const TDS_RATES = [
  { rateBp: 100, kind: "p1", section: "194C", label: "1% (194C)" },
  { rateBp: 200, kind: "p2", section: "194C", label: "2% (194C, or 194J technical)" },
  { rateBp: 1000, kind: "p10", section: "194J", label: "10% (194J)" },
] as const;

const DEFAULT_RATES_BP: readonly number[] = TDS_RATES.map((r) => r.rateBp);

/** TDS at a rate in basis points: Math.round(basePaise × rateBp / 10 000). */
export function tdsAt(basePaise: number, rateBp: number): number {
  return Math.round((basePaise * rateBp) / 10_000);
}

/**
 * The rate whose tdsAt(base) is within `tol` paise of tdsPaise — the closest one first; a tie
 * goes to the lower rate. null when none is close enough.
 */
export function nearestRate(tdsPaise: number, basePaise: number, ratesBp: readonly number[] = DEFAULT_RATES_BP, tol: number = TDS_TOLERANCE_PAISE): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const r of [...ratesBp].sort((a, b) => a - b)) {
    const diff = Math.abs(tdsPaise - tdsAt(basePaise, r));
    if (diff <= tol && diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}

/** 1% / 2% → 194C, 10% → 194J; anything else → null (the person chooses). */
export function sectionForRate(rateBp: number | null): "194C" | "194J" | null {
  if (rateBp === 100 || rateBp === 200) return "194C";
  if (rateBp === 1000) return "194J";
  return null;
}

export type TdsRateKind = "p1" | "p2" | "p10" | "on_total" | "other";
export interface TdsRateLabel { kind: TdsRateKind; label: string; rateBp: number; section: "194C" | "194J" | null }

/** "₹1,00,000" / "₹1,00,000.50" — Indian digit grouping, paise only when present. No locale APIs. */
function rupees(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const whole = String(Math.floor(abs / 100));
  const frac = abs % 100;
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  const grouped = groups.length ? `${groups.join(",")},${last3}` : last3;
  return `${neg ? "-" : ""}₹${grouped}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}

const pct = (rateBp: number) => `${rateBp % 100 === 0 ? rateBp / 100 : (rateBp / 100).toFixed(2)}%`;

/**
 * The accounts page's rate check (spec-accounts §4.5), first match wins:
 *  1. nearestRate on the TAXABLE value → p1 / p2 / p10 (p2 with a PAN whose 4th character is P or H
 *     appends the individual/HUF hint);
 *  2. else nearestRate on the TOTAL incl. GST → on_total ("<k>% on the total incl. GST — should be on ₹<taxable>");
 *  3. else other ("<rate 2 dp>% of taxable").
 * rateBp = round(tds × 10 000 / taxable), 0 when taxable is 0.
 */
export function classifyTds(tdsPaise: number, taxablePaise: number, totalPaise: number, pan?: string | null): TdsRateLabel {
  const rateBp = taxablePaise > 0 ? Math.round((tdsPaise * 10_000) / taxablePaise) : 0;
  const onTaxable = taxablePaise > 0 ? nearestRate(tdsPaise, taxablePaise) : null;
  if (onTaxable !== null) {
    const r = TDS_RATES.find((x) => x.rateBp === onTaxable)!;
    let label: string = r.label;
    const fourth = (pan ?? "").trim().toUpperCase().charAt(3);
    if (r.kind === "p2" && (fourth === "P" || fourth === "H")) label += " · a 194C deduction by an individual/HUF is 1%";
    return { kind: r.kind, label, rateBp, section: sectionForRate(onTaxable) };
  }
  const onTotal = totalPaise > 0 ? nearestRate(tdsPaise, totalPaise) : null;
  if (onTotal !== null) {
    return { kind: "on_total", label: `${pct(onTotal)} on the total incl. GST — should be on ${rupees(taxablePaise)}`, rateBp, section: sectionForRate(onTotal) };
  }
  return { kind: "other", label: `${(rateBp / 100).toFixed(2)}% of taxable`, rateBp, section: null };
}

/**
 * The PAN to show for a client: the billing profile's own PAN, else characters 3–12 of its GSTIN
 * (a GSTIN embeds the holder's PAN), else none.
 */
export function panOf(pan: string | null, gstin: string | null): { pan: string | null; source: "profile" | "gstin" | null } {
  const p = (pan ?? "").trim().toUpperCase();
  if (p) return { pan: p, source: "profile" };
  const g = (gstin ?? "").trim().toUpperCase();
  if (g.length >= 12) return { pan: g.slice(2, 12), source: "gstin" };
  return { pan: null, source: null };
}
