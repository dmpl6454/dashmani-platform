import { reconDay, reconInr } from "@dashmani/shared";

// The client's statement of account (spec-reconcile §5.3). PURE: buildLedger(statement, range,
// extra) — documents as they stand today, each on its own date. The list balance SQL
// (confirm.service.ts) is proven equal to closingPaise for to = asOf (test R-14), and for a ledger
// that runs to today the closing equals outstanding − unapplied − proforma allocations (I3).

export type LedgerKind = "invoice" | "refund" | "credit_note" | "receipt" | "tds";
export interface LedgerLine { day: string; kind: LedgerKind; docId: string; number: string; particulars: string; debitPaise: number; creditPaise: number; balancePaise: number }
export interface LedgerView {
  v: 1; company: string; clientId: string; from: string; to: string; generatedAt: string;
  seller: { legalName: string; gstin: string | null; pan: string | null; addressLines: string[]; email: string | null };
  client: { name: string; legalName: string; gstin: string | null; pan: string | null; tans: string[]; addressLines: string[] };
  openingPaise: number; lines: LedgerLine[]; totals: { debitPaise: number; creditPaise: number }; closingPaise: number; side: "Dr" | "Cr";
  excluded: Array<{ kind: "cancelled_invoice" | "voided_receipt" | "cancelled_credit_note" | "cancelled_refund"; number: string; day: string; changedOn: string | null; reason: string | null; amountPaise: number }>;
  notes: string[]; checks: { identityOk: boolean | null };
}

/** The slice of getClientStatement() the ledger reads (structural, so tests can build it by hand). */
export interface LedgerStatement {
  client: { id: string; companyName: string; email?: string | null; billingProfile: null | { legalName: string; gstin: string | null; pan: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; pincode: string | null; tan?: string | null } };
  invoices: Array<{ id: string; number: string | null; kind: string; status: string; issueDate: string | null; totalPaise: number; poNumber?: string | null }>;
  payments: Array<{ id: string; number: string; status: string; paidOn: string | null; amountPaise: number; tdsPaise: number; mode: string; reference: string | null;
    allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise: number }>;
    refunds: Array<{ id: string; number: string; status: string; refundedOn: string | null; amountPaise: number }> }>;
  creditNotes: Array<{ id: string; number: string; status: string; issueDate: Date | string; totalPaise: number; invoiceId: string }>;
  totals: { outstandingPaise: number; unappliedPaise: number };
}

export interface LedgerExtra {
  company: string;
  seller: LedgerView["seller"];
  today: string;
  generatedAt: string;
  /** id → IST day the document was cancelled / voided, and why */
  cancelInfo: Record<string, { day: string | null; reason: string | null }>;
  /** the client's TANs (profile + extra) */
  tans?: string[];
}

const MODE: Record<string, string> = { bank_transfer: "bank transfer", upi: "UPI", cheque: "cheque", cash: "cash", razorpay: "Razorpay", other: "other" };
const ORDER: Record<LedgerKind, number> = { invoice: 0, refund: 1, credit_note: 2, receipt: 3, tds: 4 };
const dayOf = (d: Date | string | null): string | null => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export function buildLedger(st: LedgerStatement, range: { from: string; to: string }, extra: LedgerExtra): LedgerView {
  const invById = new Map(st.invoices.map((i) => [i.id, i]));
  type E = { day: string; kind: LedgerKind; docId: string; number: string; particulars: string; dr: number; cr: number };
  const entries: E[] = [];
  const excluded: LedgerView["excluded"] = [];
  const notes: string[] = [];

  for (const inv of st.invoices) {
    if (inv.kind !== "tax_invoice" || !inv.issueDate || !inv.number) continue;
    if (inv.status === "issued" || inv.status === "paid") {
      entries.push({ day: inv.issueDate, kind: "invoice", docId: inv.id, number: inv.number, particulars: `Tax invoice ${inv.number}${inv.poNumber ? ` (PO ${inv.poNumber})` : ""}`, dr: inv.totalPaise, cr: 0 });
    } else if (inv.status === "cancelled") {
      const c = extra.cancelInfo[inv.id];
      excluded.push({ kind: "cancelled_invoice", number: inv.number, day: inv.issueDate, changedOn: c?.day ?? null, reason: c?.reason ?? null, amountPaise: inv.totalPaise });
    }
  }
  let proformaPaise = 0;
  for (const p of st.payments) {
    if (!p.paidOn) continue;
    if (p.status !== "recorded") {
      const c = extra.cancelInfo[p.id];
      excluded.push({ kind: "voided_receipt", number: p.number, day: p.paidOn, changedOn: c?.day ?? null, reason: c?.reason ?? null, amountPaise: p.amountPaise + p.tdsPaise });
      continue;
    }
    const proformas = p.allocations.map((a) => ({ a, inv: invById.get(a.invoiceId) })).filter((x) => x.inv && x.inv.kind === "proforma" && (x.inv.status === "issued" || x.inv.status === "paid"));
    for (const x of proformas) {
      const amt = x.a.amountPaise + x.a.tdsPaise;
      proformaPaise += amt;
      if (x.inv!.number) notes.push(`${reconInr(amt)} received against proforma ${x.inv!.number} is shown as an advance until its tax invoice is issued.`);
    }
    if (p.amountPaise > 0) {
      const detail = [MODE[p.mode] ?? p.mode, p.reference ? `ref ${p.reference}` : null].filter(Boolean).join(", ");
      const tag = p.allocations.length === 0 ? " (advance)" : proformas.length ? ` against proforma ${proformas.map((x) => x.inv!.number).filter(Boolean).join(", ")}` : "";
      entries.push({ day: p.paidOn, kind: "receipt", docId: p.id, number: p.number, particulars: `Payment received — ${p.number}${detail ? ` (${detail})` : ""}${tag}`, dr: 0, cr: p.amountPaise });
    }
    if (p.tdsPaise > 0) entries.push({ day: p.paidOn, kind: "tds", docId: p.id, number: p.number, particulars: `TDS deducted by you — ${p.number}`, dr: 0, cr: p.tdsPaise });
    for (const r of p.refunds) {
      if (!r.refundedOn) continue;
      if (r.status === "issued") entries.push({ day: r.refundedOn, kind: "refund", docId: r.id, number: r.number, particulars: `Refund paid — ${r.number} of ${p.number}`, dr: r.amountPaise, cr: 0 });
      else {
        const c = extra.cancelInfo[r.id];
        excluded.push({ kind: "cancelled_refund", number: r.number, day: r.refundedOn, changedOn: c?.day ?? null, reason: c?.reason ?? null, amountPaise: r.amountPaise });
      }
    }
  }
  for (const cn of st.creditNotes) {
    const day = dayOf(cn.issueDate);
    if (!day) continue;
    const inv = invById.get(cn.invoiceId);
    if (cn.status === "issued") {
      entries.push({ day, kind: "credit_note", docId: cn.id, number: cn.number, particulars: `Credit note ${cn.number}${inv?.number ? ` against ${inv.number}` : ""}`, dr: 0, cr: cn.totalPaise });
    } else {
      const c = extra.cancelInfo[cn.id];
      excluded.push({ kind: "cancelled_credit_note", number: cn.number, day, changedOn: c?.day ?? null, reason: c?.reason ?? null, amountPaise: cn.totalPaise });
    }
  }

  entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || ORDER[a.kind] - ORDER[b.kind] || (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
  let opening = 0;
  const lines: LedgerLine[] = [];
  let bal = 0;
  let dr = 0;
  let cr = 0;
  for (const e of entries) {
    if (e.day < range.from) { opening += e.dr - e.cr; continue; }
    if (e.day > range.to) continue;
    if (!lines.length) bal = opening;
    bal += e.dr - e.cr;
    dr += e.dr; cr += e.cr;
    lines.push({ day: e.day, kind: e.kind, docId: e.docId, number: e.number, particulars: e.particulars, debitPaise: e.dr, creditPaise: e.cr, balancePaise: bal });
  }
  const closing = opening + dr - cr;
  const identityOk = range.to >= extra.today ? closing === st.totals.outstandingPaise - st.totals.unappliedPaise - proformaPaise : null;
  excluded.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.number < b.number ? -1 : 1));
  if (excluded.length) notes.push(`Cancelled invoices and voided receipts are not shown; this statement shows documents as they stand on ${reconDay(extra.today)}.`);
  else notes.push(`This statement shows documents as they stand on ${reconDay(extra.today)}.`);

  const bp = st.client.billingProfile;
  const addr = bp ? [bp.addressLine1, bp.addressLine2, [bp.city, bp.state, bp.pincode].filter(Boolean).join(", ")].filter((x): x is string => !!x && x.trim().length > 0) : [];
  return {
    v: 1, company: extra.company, clientId: st.client.id, from: range.from, to: range.to, generatedAt: extra.generatedAt,
    seller: extra.seller,
    client: { name: st.client.companyName, legalName: bp?.legalName ?? st.client.companyName, gstin: bp?.gstin ?? null, pan: bp?.pan ?? null, tans: extra.tans ?? (bp?.tan ? [bp.tan] : []), addressLines: addr },
    openingPaise: opening, lines, totals: { debitPaise: dr, creditPaise: cr }, closingPaise: closing, side: closing >= 0 ? "Dr" : "Cr",
    excluded: excluded.filter((x) => x.day <= range.to), notes: [...new Set(notes)], checks: { identityOk },
  };
}

/** "₹56,200.00 Dr" / "₹40,000.00 Cr". */
export function drCr(paise: number): string {
  return `${reconInr(Math.abs(paise))} ${paise >= 0 ? "Dr" : "Cr"}`;
}
