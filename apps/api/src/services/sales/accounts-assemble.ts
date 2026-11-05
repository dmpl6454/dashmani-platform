import {
  AGE_BUCKETS,
  classifyTds,
  creditNoteDeadline,
  fyBounds,
  fyLabelsBetween,
  fyMonths,
  fyOfDay,
  gstr1DueDay,
  panOf,
  sellerRegistrations,
  type AgeKey,
  type CompanyKey,
  type GstSection,
  type TdsRateLabel,
} from "@dashmani/shared";
import { toSafeNumber } from "./common";
import type { FiledYearView } from "./filed.service";
import type { Q1Row, Q2bRow, Q2Row, Q3Row, Q4Row, Q5Row, Q6Row, Q7Row, Q8Row, Q9Row, Q10Row, Q11Row } from "./accounts-sql";

// Pure assembly of the accounts page (spec-accounts §3.2, §4): the query rows in, the AccountsView
// out. No I/O, no clock — `today` and `computedAt` are passed in — so every rule is unit-tested.

export type Money4 = { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
export type Money5 = Money4 & { totalPaise: number };

export interface AccountsView {
  company: CompanyKey;
  fy: { label: string; startDay: string; endDay: string; closed: boolean };
  today: string;
  computedAt: string;
  years: Array<{ fy: string; closed: boolean; liveInvoices: number; liveNetTaxablePaise: number; filed: FiledYearView | null; gapPaise: number | null }>;
  registrations: Array<{ gstin: string; label: string; current: boolean }>;
  invoiced: {
    gross: Money5 & { count: number; roundOffPaise: number };
    creditNotes: Money5 & { count: number; onEarlierYearInvoices: number };
    net: Money5;
    cancelled: { count: number; totalPaise: number };
  };
  collected: {
    receipts: number; receivedPaise: number; refundedPaise: number; netPaise: number; tdsPaise: number;
    byMode: Array<{ mode: string; receipts: number; receivedPaise: number; refundedPaise: number; netPaise: number }>;
  };
  months: Array<{ month: string; invoicedPaise: number; collectedPaise: number; tdsPaise: number; future: boolean }>;
  gst: {
    byRegistration: Array<{
      gstin: string;
      months: Array<{
        month: string; invoices: Money5 & { count: number }; creditNotes: Money5 & { count: number }; net: Money5;
        b2cTaxablePaise: number; gstr3b: { a: Money4; b: { taxablePaise: number; igstPaise: number } };
      }>;
      totals: { invoices: Money5; creditNotes: Money5; net: Money5 };
    }>;
    documents: Array<{ month: string; gstin: string; doc: "invoice" | "credit_note"; series: string; first: string; last: string; total: number; cancelled: number }>;
    warnings: Array<{ code: "CHANGED_AFTER_DUE" | "CREDIT_NOTE_LATE" | "NO_SELLER_GSTIN" | "SECTION_CHECK"; count: number; message: string; documents: Array<{ id: string; kind: "invoice" | "credit_note"; number: string }> }>;
  };
  tds: { totalPaise: number; receipts: number; byQuarter: [number, number, number, number]; clients: TdsClient[] };
  receivables: {
    asOf: string; totalPaise: number; invoices: number; overduePaise: number; fromThisFyPaise: number;
    buckets: Array<{ key: AgeKey; label: string; paise: number; invoices: number }>;
    topDebtors: Array<{ clientId: string; name: string; balancePaise: number; overduePaise: number; invoices: number; oldestDue: string }>;
  };
  unapplied: { cashPaise: number; tdsPaise: number; receipts: number; clients: number; top: Array<{ clientId: string; name: string; paise: number }> };
  bank: null | { unmatchedCount: number; unmatchedPaise: number; lastStatementDay: string | null };
  filed: FiledYearView | null;
  comparison: { state: "current" | "closed_filed" | "closed_not_filed"; filedRevenuePaise: number | null; liveNetTaxablePaise: number; gapPaise: number | null; gapBp: number | null };
}

export interface TdsClient {
  clientId: string; name: string; legalName: string | null; companyName: string; pan: string | null; panSource: "profile" | "gstin" | null; gstin: string | null;
  quarters: [number, number, number, number]; totalPaise: number; receipts: number; rates: TdsRateLabel[];
}

export interface ClientName { id: string; companyName: string; billingProfile: { legalName: string; gstin: string | null; pan: string | null } | null }

type SellerLike = Parameters<typeof sellerRegistrations>[0];

const n = (v: bigint | number | null | undefined) => toSafeNumber(v, "accounts sum");
const zero4 = (): Money4 => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
const zero5 = (): Money5 => ({ ...zero4(), totalPaise: 0 });
const add5 = (m: Money5, r: { taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint }) => {
  m.taxablePaise += n(r.taxable); m.cgstPaise += n(r.cgst); m.sgstPaise += n(r.sgst); m.igstPaise += n(r.igst); m.totalPaise += n(r.total);
};
const sub5 = (a: Money5, b: Money5): Money5 => ({
  taxablePaise: a.taxablePaise - b.taxablePaise, cgstPaise: a.cgstPaise - b.cgstPaise, sgstPaise: a.sgstPaise - b.sgstPaise,
  igstPaise: a.igstPaise - b.igstPaise, totalPaise: a.totalPaise - b.totalPaise,
});
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const nameOf = (c: ClientName | undefined) => c?.billingProfile?.legalName ?? c?.companyName ?? "—";

const AGE_LABEL = new Map(AGE_BUCKETS.map((b) => [b.key, b.label]));

/** Every registration a document can belong to: the current ones, then any former GSTIN seen in the data, then "" (none). */
export function registrationList(seller: SellerLike, seen: Iterable<string>): AccountsView["registrations"] {
  const out: AccountsView["registrations"] = [];
  const have = new Set<string>();
  for (const r of sellerRegistrations(seller)) {
    if (!r.gstin || have.has(r.gstin)) continue;
    have.add(r.gstin);
    out.push({ gstin: r.gstin, label: `${r.city ?? r.label} · ${r.gstin}`, current: true });
  }
  const extra = [...new Set(seen)].filter((g) => !have.has(g)).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  for (const g of extra) out.push({ gstin: g, label: g === "" ? "No seller GSTIN" : `Former registration · ${g}`, current: false });
  return out;
}

/** TDS per client (Q5) with the rate evidence of their paid invoices (Q6); total desc. */
export function tdsClients(q5: Q5Row[], q6: Q6Row[], names: Map<string, ClientName>, limit = 200): TdsClient[] {
  const by = new Map<string, TdsClient>();
  for (const r of q5) {
    const c = names.get(r.client_id);
    const pan = panOf(c?.billingProfile?.pan ?? null, c?.billingProfile?.gstin ?? null);
    const e = by.get(r.client_id) ?? {
      clientId: r.client_id, name: nameOf(c), legalName: c?.billingProfile?.legalName ?? null, companyName: c?.companyName ?? "—",
      pan: pan.pan, panSource: pan.source, gstin: c?.billingProfile?.gstin ?? null,
      quarters: [0, 0, 0, 0] as [number, number, number, number], totalPaise: 0, receipts: 0, rates: [] as TdsRateLabel[],
    };
    const t = n(r.tds);
    e.quarters[Math.min(4, Math.max(1, r.quarter)) - 1] += t;
    e.totalPaise += t;
    e.receipts += r.receipts;
    by.set(r.client_id, e);
  }
  for (const r of [...q6].sort((a, b) => a.id.localeCompare(b.id))) {
    const e = by.get(r.client_id);
    if (!e) continue;
    const label = classifyTds(n(r.tds), r.taxable_paise, r.total_paise, e.pan);
    if (!e.rates.some((x) => x.label === label.label)) e.rates.push(label);
  }
  return [...by.values()].sort((a, b) => b.totalPaise - a.totalPaise || a.name.localeCompare(b.name)).slice(0, limit);
}

export interface AssembleInput {
  company: CompanyKey;
  fy: string;
  today: string;
  computedAt: string;
  seller: SellerLike;
  q1: Q1Row[]; q2: Q2Row[]; q2b: Q2bRow[]; q3: Q3Row[]; q4: Q4Row[]; q5: Q5Row[]; q6: Q6Row[]; q7: Q7Row[]; q8: Q8Row[]; q9: Q9Row[]; q10: Q10Row[]; q11: Q11Row[];
  filed: FiledYearView[];
  names: ClientName[];
}

const WARN_LIMIT = 20;

export function assemble(i: AssembleInput): AccountsView {
  const b = fyBounds(i.fy)!;
  const closed = b.endDay < i.today;
  const names = new Map(i.names.map((c) => [c.id, c]));
  const months = fyMonths(i.fy);

  // ── Invoiced ──
  const gross = { ...zero5(), count: 0, roundOffPaise: 0 };
  for (const r of i.q1) { add5(gross, r); gross.count += r.docs; gross.roundOffPaise += n(r.round_off); }
  const creditNotes = { ...zero5(), count: 0, onEarlierYearInvoices: 0 };
  for (const r of i.q2) { add5(creditNotes, r); creditNotes.count += r.docs; creditNotes.onEarlierYearInvoices += r.earlier; }
  const net = sub5(gross, creditNotes);
  const cancelled = { count: i.q2b[0]?.count ?? 0, totalPaise: n(i.q2b[0]?.total ?? 0) };

  // ── Collected ──
  const modes = new Map<string, { mode: string; receipts: number; receivedPaise: number; refundedPaise: number; netPaise: number }>();
  const mode = (m: string) => modes.get(m) ?? (modes.set(m, { mode: m, receipts: 0, receivedPaise: 0, refundedPaise: 0, netPaise: 0 }), modes.get(m)!);
  let receipts = 0, receivedPaise = 0, refundedPaise = 0, tdsPaise = 0;
  for (const r of i.q3) { const e = mode(r.mode); e.receipts += r.receipts; e.receivedPaise += n(r.received); receipts += r.receipts; receivedPaise += n(r.received); tdsPaise += n(r.tds); }
  for (const r of i.q4) { const e = mode(r.mode); e.refundedPaise += n(r.refunded); refundedPaise += n(r.refunded); }
  for (const e of modes.values()) e.netPaise = e.receivedPaise - e.refundedPaise;

  // ── Monthly series ──
  const monthSeries = months.map((m) => {
    const inv = i.q1.filter((r) => r.month === m).reduce((s, r) => s + n(r.total), 0) - i.q2.filter((r) => r.month === m).reduce((s, r) => s + n(r.total), 0);
    const col = i.q3.filter((r) => r.month === m).reduce((s, r) => s + n(r.received), 0) - i.q4.filter((r) => r.month === m).reduce((s, r) => s + n(r.refunded), 0);
    const tds = i.q3.filter((r) => r.month === m).reduce((s, r) => s + n(r.tds), 0);
    return { month: m, invoicedPaise: inv, collectedPaise: col, tdsPaise: tds, future: `${m}-01` > i.today };
  });

  // ── GST by registration × month ──
  const seen = new Set<string>([...i.q1.map((r) => r.gstin), ...i.q2.map((r) => r.gstin), ...i.q9.map((r) => r.gstin)]);
  const registrations = registrationList(i.seller, seen);
  const byRegistration = registrations
    .filter((reg) => reg.current || seen.has(reg.gstin))
    .map((reg) => {
      const regMonths = months.map((m) => {
        const inv = { ...zero5(), count: 0 };
        const cn = { ...zero5(), count: 0 };
        const sec = new Map<string, Money5>();
        const secOf = (s: string) => sec.get(s) ?? (sec.set(s, zero5()), sec.get(s)!);
        for (const r of i.q1) if (r.gstin === reg.gstin && r.month === m) { add5(inv, r); inv.count += r.docs; add5(secOf(r.section), r); }
        for (const r of i.q2) if (r.gstin === reg.gstin && r.month === m) {
          add5(cn, r); cn.count += r.docs;
          // A note past the s.34(2) deadline can't reduce output tax: it stays in the credit-note
          // totals (and the register) but never in the GSTR-3B 3.1 sections.
          if (r.late) continue;
          const s = secOf(r.section);
          s.taxablePaise -= n(r.taxable); s.cgstPaise -= n(r.cgst); s.sgstPaise -= n(r.sgst); s.igstPaise -= n(r.igst); s.totalPaise -= n(r.total);
        }
        const sum = (keys: GstSection[]) => keys.reduce((acc, k) => {
          const s = sec.get(k);
          if (s) { acc.taxablePaise += s.taxablePaise; acc.cgstPaise += s.cgstPaise; acc.sgstPaise += s.sgstPaise; acc.igstPaise += s.igstPaise; acc.totalPaise += s.totalPaise; }
          return acc;
        }, zero5());
        const a = sum(["b2b", "b2cl", "b2cs"]);
        const zr = sum(["exp", "sez"]);
        const b2c = sum(["b2cl", "b2cs"]);
        return {
          month: m, invoices: inv, creditNotes: cn, net: sub5(inv, cn), b2cTaxablePaise: b2c.taxablePaise,
          gstr3b: { a: { taxablePaise: a.taxablePaise, cgstPaise: a.cgstPaise, sgstPaise: a.sgstPaise, igstPaise: a.igstPaise }, b: { taxablePaise: zr.taxablePaise, igstPaise: zr.igstPaise } },
        };
      });
      const totals = { invoices: zero5(), creditNotes: zero5(), net: zero5() };
      for (const mm of regMonths) {
        for (const k of ["invoices", "creditNotes", "net"] as const) {
          const t = totals[k]; const v = mm[k];
          t.taxablePaise += v.taxablePaise; t.cgstPaise += v.cgstPaise; t.sgstPaise += v.sgstPaise; t.igstPaise += v.igstPaise; t.totalPaise += v.totalPaise;
        }
      }
      return { gstin: reg.gstin, months: regMonths, totals };
    });

  const documents = [...i.q9]
    .sort((x, y) => x.month.localeCompare(y.month) || x.gstin.localeCompare(y.gstin) || (x.doc === y.doc ? x.series.localeCompare(y.series) : x.doc === "invoice" ? -1 : 1))
    .map((r) => ({ month: r.month, gstin: r.gstin, doc: r.doc, series: r.series, first: r.first, last: r.last, total: r.total, cancelled: r.cancelled }));

  // ── Warnings ──
  const warnings: AccountsView["gst"]["warnings"] = [];
  const changed = i.q11.filter((r) => (r.k === "cancelled" || r.k === "edited") && dayOf(r.changed_on) > gstr1DueDay(dayOf(r.issue_date)));
  const changedIds = [...new Map(changed.map((r) => [r.id, r])).values()];
  if (changedIds.length) {
    warnings.push({
      code: "CHANGED_AFTER_DUE", count: changedIds.length,
      message: `${changedIds.length} invoice${changedIds.length === 1 ? " was" : "s were"} cancelled or edited after the 11th of the following month — if that month's GSTR-1 was already filed, amend it in the next return or issue a credit note. (This uses the monthly due date; a quarterly filer can ignore it until the quarter's return is due.)`,
      documents: changedIds.slice(0, WARN_LIMIT).map((r) => ({ id: r.id, kind: "invoice" as const, number: r.number })),
    });
  }
  const late = i.q11.filter((r) => r.k === "credit_note" && dayOf(r.changed_on) > creditNoteDeadline(dayOf(r.issue_date)));
  if (late.length) {
    warnings.push({
      code: "CREDIT_NOTE_LATE", count: late.length,
      message: `${late.length} credit note${late.length === 1 ? " is" : "s are"} dated after 30 November following their invoice's year — output tax can't be reduced by them (CGST s.34(2)). They stay in the sales register, but GSTR-3B 3.1 and the CDNR file leave them out.`,
      documents: late.slice(0, WARN_LIMIT).map((r) => ({ id: r.id, kind: "credit_note" as const, number: r.number })),
    });
  }
  const noGstin = i.q1.filter((r) => r.gstin === "").reduce((s, r) => s + r.docs, 0);
  if (noGstin) {
    warnings.push({ code: "NO_SELLER_GSTIN", count: noGstin, message: `${noGstin} invoice${noGstin === 1 ? " has" : "s have"} no seller GSTIN in their frozen copy — they are left out of the GSTR-1 files.`, documents: [] });
  }
  const check = i.q1.filter((r) => r.section === "check").reduce((s, r) => s + r.docs, 0);
  if (check) {
    warnings.push({ code: "SECTION_CHECK", count: check, message: `${check} invoice${check === 1 ? "" : "s"} to unregistered Indian buyers carry no GST — check how they should be reported.`, documents: [] });
  }

  // ── TDS ──
  const byQuarter: [number, number, number, number] = [0, 0, 0, 0];
  let tdsReceipts = 0;
  for (const r of i.q5) { byQuarter[Math.min(4, Math.max(1, r.quarter)) - 1] += n(r.tds); tdsReceipts += r.receipts; }
  const tdsTotal = byQuarter.reduce((s, x) => s + x, 0);

  // ── Receivables (today, all years) ──
  const buckets = AGE_BUCKETS.map((x) => ({ key: x.key, label: AGE_LABEL.get(x.key)!, paise: 0, invoices: 0 }));
  const debtors = new Map<string, { clientId: string; name: string; balancePaise: number; overduePaise: number; invoices: number; oldestDue: string }>();
  let recTotal = 0, recInvoices = 0, recOverdue = 0, recFromFy = 0;
  for (const r of i.q7) {
    const bal = n(r.balance); const od = n(r.overdue);
    const bk = buckets.find((x) => x.key === r.bucket);
    if (bk) { bk.paise += bal; bk.invoices += r.invoices; }
    recTotal += bal; recInvoices += r.invoices; recOverdue += od; recFromFy += n(r.from_fy);
    const d = debtors.get(r.client_id) ?? { clientId: r.client_id, name: nameOf(names.get(r.client_id)), balancePaise: 0, overduePaise: 0, invoices: 0, oldestDue: dayOf(r.oldest_due) };
    d.balancePaise += bal; d.overduePaise += od; d.invoices += r.invoices;
    if (dayOf(r.oldest_due) < d.oldestDue) d.oldestDue = dayOf(r.oldest_due);
    debtors.set(r.client_id, d);
  }
  const topDebtors = [...debtors.values()].sort((a, b) => b.balancePaise - a.balancePaise || a.name.localeCompare(b.name)).slice(0, 10);

  // ── Unapplied (today) ──
  let uCash = 0, uTds = 0, uReceipts = 0;
  const uTop = i.q8.map((r) => {
    uCash += n(r.cash); uTds += n(r.tds); uReceipts += r.receipts;
    return { clientId: r.client_id, name: nameOf(names.get(r.client_id)), paise: n(r.cash) + n(r.tds) };
  }).sort((a, b) => b.paise - a.paise || a.name.localeCompare(b.name)).slice(0, 5);

  // ── Years + filed vs live ──
  const current = fyOfDay(i.today);
  const liveByFy = new Map(i.q10.map((r) => [`${r.fy_start}-${String((r.fy_start + 1) % 100).padStart(2, "0")}`, { invoices: r.invoices, taxable: n(r.taxable_net) }]));
  const filedByFy = new Map(i.filed.map((f) => [f.fy, f]));
  const startOf = (fy: string) => Number(fy.slice(0, 4));
  const floor = Math.min(startOf(current) - 3, ...[...liveByFy.keys(), ...filedByFy.keys()].map(startOf));
  const firstFy = `${floor}-${String((floor + 1) % 100).padStart(2, "0")}`;
  const years = fyLabelsBetween(firstFy, current).map((fy) => {
    const yb = fyBounds(fy)!;
    const yClosed = yb.endDay < i.today;
    const live = liveByFy.get(fy) ?? { invoices: 0, taxable: 0 };
    const filed = filedByFy.get(fy) ?? null;
    const rev = filed?.figures.revenuePaise ?? null;
    return { fy, closed: yClosed, liveInvoices: live.invoices, liveNetTaxablePaise: live.taxable, filed, gapPaise: yClosed && rev != null ? rev - live.taxable : null };
  });

  const filed = filedByFy.get(i.fy) ?? null;
  const filedRevenue = filed?.figures.revenuePaise ?? null;
  const gap = closed && filedRevenue != null ? filedRevenue - net.taxablePaise : null;
  const comparison: AccountsView["comparison"] = {
    state: !closed ? "current" : filed ? "closed_filed" : "closed_not_filed",
    filedRevenuePaise: closed ? filedRevenue : null,
    liveNetTaxablePaise: net.taxablePaise,
    gapPaise: gap,
    gapBp: gap != null && filedRevenue ? Math.round((gap * 10_000) / filedRevenue) : null,
  };

  return {
    company: i.company,
    fy: { label: b.label, startDay: b.startDay, endDay: b.endDay, closed },
    today: i.today,
    computedAt: i.computedAt,
    years,
    registrations,
    invoiced: { gross, creditNotes, net, cancelled },
    collected: { receipts, receivedPaise, refundedPaise, netPaise: receivedPaise - refundedPaise, tdsPaise, byMode: [...modes.values()].sort((a, b) => b.netPaise - a.netPaise || a.mode.localeCompare(b.mode)) },
    months: monthSeries,
    gst: { byRegistration, documents, warnings },
    tds: { totalPaise: tdsTotal, receipts: tdsReceipts, byQuarter, clients: tdsClients(i.q5, i.q6, names) },
    receivables: { asOf: i.today, totalPaise: recTotal, invoices: recInvoices, overduePaise: recOverdue, fromThisFyPaise: recFromFy, buckets, topDebtors },
    unapplied: { cashPaise: uCash, tdsPaise: uTds, receipts: uReceipts, clients: i.q8.length, top: uTop },
    bank: null,
    filed,
    comparison,
  };
}
