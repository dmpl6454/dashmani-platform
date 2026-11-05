// Bank statement matching — the bank-specific names shared by the API matcher and the portal's
// TDS cut (spec-bank §3.4). Pure: no I/O, no Date. Money in paise. The TDS rules themselves
// (TDS_RATES, tdsAt, nearestRate, sectionForRate…) live in ./tds and are imported, never re-exported
// (barrel rule: one exporter per name). The portal imports this file BY PATH.

import { TDS_TOLERANCE_PAISE } from "./tds";

/** ±₹1: a credit that differs from a receipt or a TDS shortfall by up to a rupee still "fits". */
export const BANK_TOLERANCE_PAISE = TDS_TOLERANCE_PAISE;
/** A recorded receipt within ±3 days of a credit of the same amount is the same money. */
export const BANK_LINK_WINDOW_DAYS = 3;

export const BANK_IGNORE_LABELS: Record<string, string> = {
  own_transfer: "Transfer between our own accounts",
  gst_refund: "GST refund",
  tax_refund: "Income-tax refund",
  interest: "Bank interest / FD",
  loan_capital: "Loan or capital",
  gateway: "Payment-gateway settlement (Razorpay etc.)",
  salary: "Salary or staff reimbursement",
  vendor_refund: "Refund from a vendor",
  reversal: "Reversal or bounced payment",
  duplicate: "Duplicate of another line",
  other: "Something else",
  debit: "Withdrawal",
  before_cutover: "Before bank matching started",
};

export const BANK_PRESET_LABELS: Record<string, string> = {
  idfc: "IDFC First Bank",
  icici: "ICICI Bank",
  hdfc: "HDFC Bank",
  sbi: "State Bank of India",
  axis: "Axis Bank",
  kotak: "Kotak Mahindra Bank",
  yes: "YES Bank",
  other: "Other bank",
};

/**
 * Each preset's typical heading row (normalised: lower case, bracketed text and punctuation
 * dropped). HINTS ONLY — the header detector works from synonyms; a preset only breaks a tie and
 * names the layout. Written from the banks' published formats, not from real files: verify each
 * against a real download before relying on it.
 */
export const BANK_PRESET_HEADERS: Record<string, string[]> = {
  idfc: ["transaction date", "value date", "particulars", "cheque no", "debit", "credit", "balance"],
  icici: ["value date", "transaction date", "cheque number", "transaction remarks", "withdrawal amount", "deposit amount", "balance"],
  hdfc: ["date", "narration", "chq ref no", "value dt", "withdrawal amt", "deposit amt", "closing balance"],
  sbi: ["txn date", "value date", "description", "ref no cheque no", "debit", "credit", "balance"],
  axis: ["tran date", "chqno", "particulars", "dr", "cr", "bal"],
  kotak: ["transaction date", "value date", "description", "chq ref no", "debit", "credit", "balance"],
  yes: ["transaction date", "value date", "cheque no reference no", "description", "withdrawals", "deposits", "running balance"],
};

/** The last four digits of an account number ("88452818788" → "8788"). */
export function last4(accountNumber: string): string {
  const d = accountNumber.replace(/\D/g, "");
  return d.slice(-4);
}

/** Taxable value net of issued credit notes — the base TDS is deducted on. */
export function netTaxable(inv: { taxablePaise: number; creditedTaxablePaise: number }): number {
  return Math.max(0, inv.taxablePaise - inv.creditedTaxablePaise);
}

/** Invoice total net of issued credit notes. */
export function netGross(inv: { totalPaise: number; creditedPaise: number }): number {
  return Math.max(0, inv.totalPaise - inv.creditedPaise);
}

/**
 * "Settle in full": the cash received closes the selected invoices once the rest is TDS. Total TDS
 * = Σbalance − cash (null when the cash is more than the balances), spread over the invoices in
 * proportion to basePaise (their taxable value) by largest remainder, never more than an
 * invoice's own balance; amount_i = balance_i − tds_i, so every invoice closes exactly.
 */
export function splitTds(
  invs: Array<{ id: string; balancePaise: number; basePaise: number }>,
  cashPaise: number,
): Array<{ id: string; amountPaise: number; tdsPaise: number }> | null {
  const totalBalance = invs.reduce((s, i) => s + Math.max(0, i.balancePaise), 0);
  const totalTds = totalBalance - cashPaise;
  if (!invs.length || cashPaise < 0 || totalTds < 0) return null;
  const tds = new Map<string, number>(invs.map((i) => [i.id, 0]));
  let left = totalTds;
  // Each round spreads what is left over the invoices that still have room, by base; an invoice
  // whose share would exceed its balance is capped and the excess goes round again.
  let open = invs.filter((i) => i.balancePaise > 0);
  for (let round = 0; left > 0 && open.length && round < invs.length + 1; round++) {
    const baseSum = open.reduce((s, i) => s + Math.max(0, i.basePaise), 0);
    const weights = open.map((i) => (baseSum > 0 ? Math.max(0, i.basePaise) : 1));
    const wSum = weights.reduce((s, w) => s + w, 0);
    const raw = open.map((_, k) => (left * weights[k]) / wSum);
    const floors = raw.map((r) => Math.floor(r));
    let rem = left - floors.reduce((s, f) => s + f, 0);
    const order = raw.map((r, k) => ({ k, frac: r - floors[k] })).sort((a, b) => b.frac - a.frac || a.k - b.k);
    for (const o of order) {
      if (rem <= 0) break;
      floors[o.k] += 1;
      rem -= 1;
    }
    let given = 0;
    const next: typeof open = [];
    open.forEach((inv, k) => {
      const room = inv.balancePaise - (tds.get(inv.id) ?? 0);
      const add = Math.min(room, floors[k]);
      tds.set(inv.id, (tds.get(inv.id) ?? 0) + add);
      given += add;
      if (room - add > 0) next.push(inv);
    });
    left -= given;
    open = next;
  }
  if (left > 0) return null;
  return invs.map((i) => {
    const t = tds.get(i.id) ?? 0;
    return { id: i.id, amountPaise: Math.max(0, i.balancePaise) - t, tdsPaise: t };
  });
}

/** "₹1,16,000.00" — Indian digit grouping, always two decimals. No locale APIs (deterministic). */
export function bankInr(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  const grouped = groups.length ? `${groups.join(",")},${last3}` : last3;
  return `${neg ? "-" : ""}₹${grouped}.${String(abs % 100).padStart(2, "0")}`;
}

/** "10%", "2%", "0.75%" — a rate in basis points as people write it. */
export function bankPct(rateBp: number): string {
  return `${rateBp % 100 === 0 ? rateBp / 100 : (rateBp / 100).toFixed(2).replace(/0$/, "")}%`;
}
