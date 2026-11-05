import { Prisma } from "@dashmani/db";
import { SALES_COMPANIES, type CompanyKey, type TallyMode } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { dateToDay, dayToDate, istDayOf, toSafeNumber, type Tx } from "../common";
import type { SellerProfile } from "../settings.service";
import type { ClientInfo, LastGood, PartyMapping, PlanDoc, PlanInput } from "./plan";
import { getTallySettingsRow, registrationsView, tallyMissing, type TallySettings } from "./settings";
import type { AllocationDoc, AnyDoc, BuyerSnap, CreditNoteDoc, InvoiceDoc, ReceiptDoc, RefundDoc, SellerSnap } from "./vouchers";

// The DB reads behind a preview or a run (spec-tally §4.2). Everything here runs inside the
// caller's RepeatableRead transaction (`tx` only — never the global client, which would need a
// second connection the test pool does not have). Reads only: invariant I1.

export const maxDocs = () => {
  const n = Number(process.env.SALES_TALLY_MAX_DOCS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
};

const invoiceInclude = {
  items: { orderBy: { position: "asc" as const }, select: { description: true, sac: true, amountPaise: true } },
  order: { select: { number: true } },
  einvoice: { select: { irn: true, status: true } },
} satisfies Prisma.SalesInvoiceInclude;
type InvoiceRow = Prisma.SalesInvoiceGetPayload<{ include: typeof invoiceInclude }>;

const allocationInclude = {
  orderBy: { createdAt: "asc" as const },
  include: { invoice: { select: { number: true, kind: true, status: true, issueDate: true, sellerSnapshot: true } } },
} as const;

export function toInvoiceDoc(i: InvoiceRow): InvoiceDoc {
  return {
    id: i.id, companyKey: i.companyKey, number: i.number ?? "", kind: i.kind, issueDate: dateToDay(i.issueDate) ?? "", status: i.status,
    cancelledDay: i.cancelledAt ? istDayOf(i.cancelledAt) : null, cancelReason: i.cancelReason, clientId: i.clientId,
    placeOfSupplyCode: i.placeOfSupplyCode, taxMode: i.taxMode, gstRateBp: i.gstRateBp,
    seller: (i.sellerSnapshot ?? {}) as SellerSnap, buyer: (i.buyerSnapshot ?? {}) as BuyerSnap,
    taxablePaise: i.taxablePaise, cgstPaise: i.cgstPaise, sgstPaise: i.sgstPaise, igstPaise: i.igstPaise, roundOffPaise: i.roundOffPaise, totalPaise: i.totalPaise,
    notes: i.notes, poNumber: i.poNumber, poDate: dateToDay(i.poDate), orderNumber: i.order?.number ?? null,
    irn: i.einvoice?.irn && i.einvoice.status === "registered" ? i.einvoice.irn : null,
    items: i.items.map((x) => ({ description: x.description, sac: x.sac, amountPaise: x.amountPaise })),
  };
}

type AllocRow = { invoiceId: string; amountPaise: number; tdsPaise: number; createdAt: Date; invoice: { number: string | null; kind: string; status: string; issueDate: Date | null; sellerSnapshot: Prisma.JsonValue } };
const toAlloc = (a: AllocRow): AllocationDoc => ({
  invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise, createdAt: a.createdAt.toISOString(),
  invoiceNumber: a.invoice.number, invoiceKind: a.invoice.kind, invoiceStatus: a.invoice.status, invoiceDate: dateToDay(a.invoice.issueDate),
  invoiceGstin: ((a.invoice.sellerSnapshot ?? {}) as SellerSnap).gstin ?? null,
});

/** §4.3 R5: a receipt routes by its first allocation (by time) to a tax invoice, else the principal registration. */
export function receiptRouteGstin(allocs: AllocationDoc[], principalGstin: string | null): string | null {
  const first = allocs.find((a) => a.invoiceKind === "tax_invoice" && a.invoiceGstin);
  return first?.invoiceGstin ?? principalGstin;
}

// ── Loaders (same shape for period documents, earlier changes and pull-in candidates) ──

export async function loadInvoices(tx: Tx, where: Prisma.SalesInvoiceWhereInput): Promise<InvoiceDoc[]> {
  const rows = await tx.salesInvoice.findMany({
    where: { kind: "tax_invoice", number: { not: null }, status: { in: ["issued", "paid", "cancelled"] }, issueDate: { not: null }, ...where },
    include: invoiceInclude,
  });
  return rows.map(toInvoiceDoc);
}
export async function loadCreditNotes(tx: Tx, where: Prisma.SalesCreditNoteWhereInput): Promise<CreditNoteDoc[]> {
  const rows = await tx.salesCreditNote.findMany({ where, include: { invoice: { include: invoiceInclude } } });
  return rows.map((c) => ({
    id: c.id, number: c.number, issueDate: dateToDay(c.issueDate)!, status: c.status, cancelledDay: c.cancelledAt ? istDayOf(c.cancelledAt) : null,
    reason: c.reason, clientId: c.clientId, taxablePaise: c.taxablePaise, cgstPaise: c.cgstPaise, sgstPaise: c.sgstPaise, igstPaise: c.igstPaise,
    totalPaise: c.totalPaise, invoice: toInvoiceDoc(c.invoice),
  }));
}
export async function loadReceipts(tx: Tx, where: Prisma.SalesPaymentWhereInput): Promise<ReceiptDoc[]> {
  const rows = await tx.salesPayment.findMany({ where, include: { allocations: allocationInclude } });
  return rows.map((p) => ({
    id: p.id, companyKey: p.companyKey, number: p.number, clientId: p.clientId, amountPaise: p.amountPaise, tdsPaise: p.tdsPaise, mode: p.mode,
    reference: p.reference, paidOn: dateToDay(p.paidOn)!, notes: p.notes, status: p.status, voidedDay: p.voidedAt ? istDayOf(p.voidedAt) : null,
    voidReason: p.voidReason, allocations: p.allocations.map(toAlloc),
  }));
}
export async function loadRefunds(tx: Tx, where: Prisma.SalesRefundWhereInput): Promise<RefundDoc[]> {
  const rows = await tx.salesRefund.findMany({ where, include: { payment: { include: { allocations: allocationInclude } } } });
  return rows.map((f) => ({
    id: f.id, number: f.number, paymentId: f.paymentId, receiptNumber: f.payment.number, receiptStatus: f.payment.status, clientId: f.clientId,
    amountPaise: f.amountPaise, mode: f.mode, reference: f.reference, refundedOn: dateToDay(f.refundedOn)!, notes: f.notes, status: f.status,
    cancelledDay: f.cancelledAt ? istDayOf(f.cancelledAt) : null, receiptAllocations: f.payment.allocations.map(toAlloc),
  }));
}

/** The seller GSTIN a document routes by. */
export function routeOf(d: AnyDoc, principalGstin: string | null): string | null {
  switch (d.docType) {
    case "invoice": return d.doc.seller.gstin ?? null;
    case "credit_note": return d.doc.invoice.seller.gstin ?? null;
    case "receipt": return receiptRouteGstin(d.doc.allocations, principalGstin);
    case "refund": return receiptRouteGstin(d.doc.receiptAllocations, principalGstin);
  }
}
export const docDay = (d: AnyDoc) =>
  d.docType === "invoice" || d.docType === "credit_note" ? d.doc.issueDate : d.docType === "receipt" ? d.doc.paidOn : d.doc.refundedOn;

/** (e) Each document's last good Tally state: its newest synced / adopted item. */
export async function loadLastGood(tx: Tx, company: CompanyKey, ids: string[]): Promise<Map<string, LastGood>> {
  if (!ids.length) return new Map();
  const rows = await tx.$queryRaw<Array<{ doc_id: string; action: string; content_hash: string | null; party_amount_paise: bigint; run_id: string; run_no: number; at: Date | null }>>`
    SELECT DISTINCT ON (i.doc_id) i.doc_id, i.action, i.content_hash, i.party_amount_paise, i.run_id, r.run_no, COALESCE(i.resolved_at, i.created_at) AS at
    FROM sales_tally_items i JOIN sales_tally_runs r ON r.id = i.run_id
    WHERE i.company_key = ${company} AND i.doc_id = ANY(${ids}::text[]) AND i.outcome IN ('synced', 'adopted')
    ORDER BY i.doc_id, i.resolved_at DESC NULLS LAST, i.created_at DESC`;
  return new Map(rows.map((r) => [r.doc_id, {
    action: r.action, contentHash: r.content_hash, partyAmountPaise: toSafeNumber(r.party_amount_paise), runNo: Number(r.run_no), runId: r.run_id,
    at: (r.at ?? new Date(0)).toISOString(),
  }]));
}

/** (f) Documents built into a synced run that may have changed since (signals only nominate; the hash decides). */
async function nominateEarlier(tx: Tx, company: CompanyKey): Promise<Array<{ doc_type: string; doc_id: string }>> {
  return tx.$queryRaw<Array<{ doc_type: string; doc_id: string }>>`
    WITH good AS (
      SELECT DISTINCT ON (doc_id) doc_id, doc_type, created_at AS built_at
      FROM sales_tally_items
      WHERE company_key = ${company} AND outcome IN ('synced', 'adopted')
      ORDER BY doc_id, resolved_at DESC NULLS LAST, created_at DESC)
    SELECT g.doc_type, g.doc_id FROM good g
    WHERE (g.doc_type = 'invoice'     AND EXISTS (SELECT 1 FROM sales_invoices v WHERE v.id = g.doc_id AND v.updated_at > g.built_at))
       OR (g.doc_type = 'credit_note' AND EXISTS (SELECT 1 FROM sales_credit_notes c WHERE c.id = g.doc_id AND c.cancelled_at > g.built_at))
       OR (g.doc_type = 'refund'      AND EXISTS (SELECT 1 FROM sales_refunds r WHERE r.id = g.doc_id AND r.cancelled_at > g.built_at))
       OR (g.doc_type = 'receipt'     AND (
              EXISTS (SELECT 1 FROM sales_payments p WHERE p.id = g.doc_id AND p.voided_at > g.built_at)
           OR EXISTS (SELECT 1 FROM sales_events e WHERE e.entity_type = 'payment' AND e.entity_id = g.doc_id AND e.created_at > g.built_at)
           OR EXISTS (SELECT 1 FROM sales_payment_allocations a JOIN sales_invoices v ON v.id = a.invoice_id
                      WHERE a.payment_id = g.doc_id AND (a.created_at > g.built_at OR v.updated_at > g.built_at))))`;
}

/** Load documents by type + id (earlier changes, manual resolution, a document's status). */
export async function loadDocsByRef(tx: Tx, company: CompanyKey, refs: Array<{ docType: string; docId: string }>): Promise<AnyDoc[]> {
  const ids = (t: string) => refs.filter((r) => r.docType === t).map((r) => r.docId);
  const [inv, cn, rc, rf] = await Promise.all([
    ids("invoice").length ? loadInvoices(tx, { id: { in: ids("invoice") }, companyKey: company }) : [],
    ids("credit_note").length ? loadCreditNotes(tx, { id: { in: ids("credit_note") }, invoice: { companyKey: company } }) : [],
    ids("receipt").length ? loadReceipts(tx, { id: { in: ids("receipt") }, companyKey: company }) : [],
    ids("refund").length ? loadRefunds(tx, { id: { in: ids("refund") }, payment: { companyKey: company } }) : [],
  ]);
  return [
    ...inv.map((doc) => ({ docType: "invoice" as const, doc })), ...cn.map((doc) => ({ docType: "credit_note" as const, doc })),
    ...rc.map((doc) => ({ docType: "receipt" as const, doc })), ...rf.map((doc) => ({ docType: "refund" as const, doc })),
  ];
}

export async function loadClients(tx: Tx, ids: string[]): Promise<Map<string, ClientInfo>> {
  const rows = await tx.client.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true, billingProfile: true } });
  return new Map(rows.map((c) => [c.id, {
    id: c.id, companyName: c.companyName, legalName: c.billingProfile?.legalName ?? null, gstin: c.billingProfile?.gstin ?? null, pan: c.billingProfile?.pan ?? null,
    addressLine1: c.billingProfile?.addressLine1 ?? null, addressLine2: c.billingProfile?.addressLine2 ?? null, city: c.billingProfile?.city ?? null,
    pincode: c.billingProfile?.pincode ?? null, stateCode: c.billingProfile?.stateCode ?? null, country: c.billingProfile?.country ?? "IN",
  }]));
}

export async function loadMappings(tx: Tx, company: CompanyKey): Promise<PartyMapping[]> {
  const rows = await tx.salesTallyParty.findMany({ where: { companyKey: company } });
  return rows.map((m) => ({ clientId: m.clientId, ledgerName: m.ledgerName, ledgerKey: m.ledgerKey, gstin: m.gstin, existsInTally: m.existsInTally, lockedAt: m.lockedAt?.toISOString() ?? null }));
}

/** count(runs) : max(updated_at) — moves whenever a run is created, confirmed, discarded or closed (§4.10). */
export async function stateVersion(tx: Tx, company: CompanyKey): Promise<string> {
  const [r] = await tx.$queryRaw<Array<{ n: number; m: Date | null }>>`SELECT count(*)::int AS n, max(updated_at) AS m FROM sales_tally_runs WHERE company_key = ${company}`;
  return `${r.n}:${r.m ? r.m.toISOString() : "-"}`;
}

export const OPEN_STATUSES = ["open", "queued", "pushing", "partial"];

export interface CollectQuery { company: CompanyKey; from: string; to: string; gstin?: string | null; mode: TallyMode }
export interface Collected {
  input: PlanInput;
  settings: TallySettings;
  tallyCompany: string;
  scopeGstin: string | null;
  openRun: { id: string; runNo: number; status: string } | null;
}

/** The settings, or the 409 every export route answers when Tally isn't set up (never a fallback to defaults). */
export async function requireSettings(tx: Tx, company: CompanyKey, seller: SellerProfile) {
  const row = await getTallySettingsRow(company, tx);
  const missing = tallyMissing(row?.settings ?? null, seller);
  if (!row || missing.length) {
    throw new AppError(409, "TALLY_NOT_CONFIGURED", `Tally isn't set up for ${SALES_COMPANIES[company].short} yet — an admin fills in Tally settings: ${missing.join("; ")}.`);
  }
  return row;
}

export async function collectTally(tx: Tx, q: CollectQuery, seller: SellerProfile, today: string): Promise<Collected> {
  const company = q.company;
  const row = await requireSettings(tx, company, seller);
  const s = row.settings;
  const regs = registrationsView(seller);
  const routing = new Map(s.registrations.map((r) => [r.gstin, r.tallyCompany]));

  // Routing (§4.2 step 2).
  let scopeGstins: string[];
  let tallyCompany: string;
  const scopeGstin = q.gstin ? q.gstin.toUpperCase() : null;
  if (scopeGstin) {
    if (!regs.some((r) => r.gstin === scopeGstin)) throw new AppError(400, "UNKNOWN_REGISTRATION", `${scopeGstin} is not one of ${SALES_COMPANIES[company].name}'s GST registrations in Settings — pick one of its GSTINs, or Automatic`);
    tallyCompany = routing.get(scopeGstin)!;
    scopeGstins = [scopeGstin];
  } else {
    const companies = [...new Set(regs.map((r) => routing.get(r.gstin)!))];
    if (companies.length > 1) {
      const a = regs.find((r) => routing.get(r.gstin) === companies[0])!;
      const b = regs.find((r) => routing.get(r.gstin) === companies[1])!;
      throw new AppError(422, "TALLY_PICK_REGISTRATION", `${a.label} and ${b.label} go to different Tally companies — pick one registration at a time.`);
    }
    tallyCompany = companies[0];
    scopeGstins = regs.map((r) => r.gstin);
  }

  // Window (§4.2 step 3).
  const booksFrom = s.booksFrom!;
  if (q.to < booksFrom) {
    throw new AppError(422, "TALLY_PERIOD_BEFORE_BOOKS", `This period ends before ${booksFrom}, the day the portal starts sending documents to Tally. Earlier documents are already in Tally.`);
  }
  const lo = q.from > booksFrom ? q.from : booksFrom;
  const range = { gte: dayToDate(lo), lte: dayToDate(q.to) };

  // Size cap before loading anything wide.
  const [ni, nc, nr, nf] = await Promise.all([
    tx.salesInvoice.count({ where: { companyKey: company, kind: "tax_invoice", number: { not: null }, status: { in: ["issued", "paid", "cancelled"] }, issueDate: range } }),
    tx.salesCreditNote.count({ where: { invoice: { companyKey: company }, issueDate: range } }),
    tx.salesPayment.count({ where: { companyKey: company, paidOn: range } }),
    tx.salesRefund.count({ where: { payment: { companyKey: company }, refundedOn: range } }),
  ]);
  const total = ni + nc + nr + nf;
  if (total > maxDocs()) throw new AppError(422, "TALLY_RUN_TOO_LARGE", `That is ${total} documents — at most ${maxDocs()} at once. Pick a shorter period.`);

  const [invoices, creditNotes, receipts, refunds] = await Promise.all([
    loadInvoices(tx, { companyKey: company, issueDate: range }),
    loadCreditNotes(tx, { invoice: { companyKey: company }, issueDate: range }),
    loadReceipts(tx, { companyKey: company, paidOn: range }),
    loadRefunds(tx, { payment: { companyKey: company }, refundedOn: range }),
  ]);
  const principal = seller.gstin ?? null;
  const inScope = (g: string | null) => !!g && scopeGstins.includes(g) && routing.get(g) === tallyCompany;
  const period: AnyDoc[] = [
    ...invoices.map((doc) => ({ docType: "invoice" as const, doc })), ...creditNotes.map((doc) => ({ docType: "credit_note" as const, doc })),
    ...receipts.map((doc) => ({ docType: "receipt" as const, doc })), ...refunds.map((doc) => ({ docType: "refund" as const, doc })),
  ].filter((d) => inScope(routeOf(d, principal)));

  // Documents in [from, booksFrom) are only counted.
  let beforeBooks = 0;
  if (q.from < booksFrom) {
    const pre = { gte: dayToDate(q.from), lt: dayToDate(booksFrom) };
    const [pi, pc, pr, pf] = await Promise.all([
      loadInvoices(tx, { companyKey: company, issueDate: pre }),
      loadCreditNotes(tx, { invoice: { companyKey: company }, issueDate: pre }),
      loadReceipts(tx, { companyKey: company, paidOn: pre }),
      loadRefunds(tx, { payment: { companyKey: company }, refundedOn: pre }),
    ]);
    beforeBooks = [
      ...pi.map((doc) => ({ docType: "invoice" as const, doc })), ...pc.map((doc) => ({ docType: "credit_note" as const, doc })),
      ...pr.map((doc) => ({ docType: "receipt" as const, doc })), ...pf.map((doc) => ({ docType: "refund" as const, doc })),
    ].filter((d) => inScope(routeOf(d, principal))).length;
  }

  // (f) Earlier documents that changed after they were sent (both modes).
  const loaded = new Set(period.map((d) => d.doc.id));
  const nominated = (await nominateEarlier(tx, company)).filter((n) => !loaded.has(n.doc_id));
  const earlier = (await loadDocsByRef(tx, company, nominated.map((n) => ({ docType: n.doc_type, docId: n.doc_id }))))
    .filter((d) => { const day = docDay(d); return day >= booksFrom && (day < lo || day > q.to) && inScope(routeOf(d, principal)); });
  for (const d of earlier) loaded.add(d.doc.id);

  // Pull-in candidates: every tax invoice a receipt or credit note here refers to, not loaded yet.
  const wanted = new Set<string>();
  for (const d of [...period, ...earlier]) {
    if (d.docType === "credit_note") wanted.add(d.doc.invoice.id);
    if (d.docType === "receipt") for (const a of d.doc.allocations) if (a.invoiceKind === "tax_invoice") wanted.add(a.invoiceId);
  }
  const candidateIds = [...wanted].filter((id) => !loaded.has(id));
  const candidates = candidateIds.length ? await loadInvoices(tx, { id: { in: candidateIds }, companyKey: company }) : [];

  const docs: PlanDoc[] = [];
  const push = (d: AnyDoc, origin: PlanDoc["origin"]) => {
    const g = routeOf(d, principal);
    docs.push({ d, routeGstin: g, tallyCompany: g ? routing.get(g) ?? null : null, origin });
  };
  period.forEach((d) => push(d, "period"));
  earlier.forEach((d) => push(d, "earlier"));
  candidates.forEach((doc) => push({ docType: "invoice", doc }, "candidate"));

  const ids = docs.map((p) => p.d.doc.id);
  const clientIds = [...new Set(docs.map((p) => p.d.doc.clientId))];
  const [lastGood, mappings, clients, version, open, sentBefore] = await Promise.all([
    loadLastGood(tx, company, ids),
    loadMappings(tx, company),
    loadClients(tx, clientIds),
    stateVersion(tx, company),
    tx.salesTallyRun.findFirst({ where: { companyKey: company, tallyCompany, status: { in: OPEN_STATUSES } }, select: { id: true, runNo: true, status: true } }),
    tx.salesTallyRun.count({ where: { companyKey: company, tallyCompany, status: { in: ["confirmed", "pushed", "partial", "closed"] } } }),
  ]);

  return {
    settings: s, tallyCompany, scopeGstin, openRun: open,
    input: {
      company, tallyCompany, scopeGstin, scopeGstins, registrations: regs, release: s.release, mode: q.mode,
      from: q.from, to: q.to, effectiveFrom: lo, booksFrom, today, settings: s, defaultSac: seller.defaultSac,
      docs, lastGood, mappings, clients, beforeBooks, openRun: open, firstExport: sentBefore === 0,
      settingsUpdatedAt: row.updatedAt.toISOString(), stateVersion: version,
    },
  };
}
