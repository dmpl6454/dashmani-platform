import { createHash } from "crypto";
import { PAYMENT_MODE_LABELS, type TallySettingsInput } from "@dashmani/shared";
import { splitExact } from "./money";
import { amt, countryName, cut, dmy, rsText, tallyDate, tallyStateName, XmlWriter } from "./xml";

// The pure voucher builders (spec-tally §4.5, §4.8, §4.10). A builder turns one portal document
// into roles + signed paise (debit < 0), checks Σ = 0 and Σ bills = party (assertBalanced), and
// derives the voucher's accounting substance — hashed BY ROLE, never by ledger name, so renaming a
// ledger in settings never re-sends a year of vouchers. Rendering to XML is separate.

export type TallySettings = TallySettingsInput;
export type DocType = "invoice" | "credit_note" | "receipt" | "refund";

export interface BuyerSnap {
  legalName?: string | null; companyName?: string | null; gstin?: string | null; pan?: string | null;
  addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null;
  stateCode?: string | null; pincode?: string | null; country?: string | null;
}
export interface SellerSnap { gstin?: string | null; stateCode?: string | null; state?: string | null; legalName?: string | null }

export interface InvoiceDoc {
  id: string; companyKey: string; number: string; kind: string; issueDate: string; status: string;
  /** IST day the invoice was cancelled, null when live */
  cancelledDay: string | null; cancelReason: string | null; clientId: string;
  placeOfSupplyCode: string | null; taxMode: string; gstRateBp: number;
  seller: SellerSnap; buyer: BuyerSnap;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number;
  notes: string | null; poNumber: string | null; poDate: string | null; orderNumber: string | null; irn: string | null;
  items: Array<{ description: string; sac: string | null; amountPaise: number }>;
}
export interface CreditNoteDoc {
  id: string; number: string; issueDate: string; status: string; cancelledDay: string | null; reason: string; clientId: string;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number;
  invoice: InvoiceDoc;
}
export interface AllocationDoc {
  invoiceId: string; amountPaise: number; tdsPaise: number; createdAt: string;
  invoiceNumber: string | null; invoiceKind: string; invoiceStatus: string; invoiceDate: string | null; invoiceGstin: string | null;
}
export interface ReceiptDoc {
  id: string; companyKey: string; number: string; clientId: string; amountPaise: number; tdsPaise: number;
  mode: string; reference: string | null; paidOn: string; notes: string | null; status: string;
  voidedDay: string | null; voidReason: string | null; allocations: AllocationDoc[];
}
export interface RefundDoc {
  id: string; number: string; paymentId: string; receiptNumber: string; receiptStatus: string; clientId: string; amountPaise: number;
  mode: string; reference: string | null; refundedOn: string; notes: string | null; status: string; cancelledDay: string | null;
  /** the receipt's allocations (routing, §4.3 R5) */
  receiptAllocations: AllocationDoc[];
}
export type AnyDoc =
  | { docType: "invoice"; doc: InvoiceDoc }
  | { docType: "credit_note"; doc: CreditNoteDoc }
  | { docType: "receipt"; doc: ReceiptDoc }
  | { docType: "refund"; doc: RefundDoc };

export interface VBill { type: "New Ref" | "Agst Ref" | "On Account"; name: string; paise: number }
export interface VBank { txnType: string; instrument: string | null; favouring: string }
export interface VEntry { role: string; ledger: string; paise: number; party?: boolean; duty?: boolean; bills?: VBill[]; bank?: VBank | null }

export interface Voucher {
  docType: DocType; docId: string; clientId: string; number: string; date: string; remoteId: string;
  voucherType: string; view: "invoice" | "accounting";
  /** a cancelled / voided document: written as ISCANCELLED (never sent) or ACTION="Cancel" (sent before) */
  cancelled: boolean;
  partyLedger: string;
  /** what the party ledger is debited/credited, unsigned (a receipt's is cash + TDS) */
  partyPaise: number;
  head: {
    buyerName: string | null; address: string[]; pincode: string | null; stateName: string | null; country: string;
    registered: boolean; partyGstin: string | null; pos: string | null; cmpGstin: string | null; cmpState: string | null;
    registrationName: string | null; reference: { number: string; date: string } | null; order: { po: string; date: string | null } | null;
  } | null;
  narration: string;
  cancelNarration: string;
  entries: VEntry[];
  substance: Substance;
}

export interface Substance {
  v: 1; type: DocType; number: string; date: string; cancelled: boolean;
  clientId: string; partyGstin: string | null; partyRegType: "registered" | "unregistered"; pos: string | null; sellerGstin: string | null;
  entries: Array<[string, number]>;
  bills: Array<[string, string, number]>;
  ref: [string, string] | null;
  instrument: [string, string | null, string] | null;
  narrationCore: Array<string | null>;
}

export interface BuildCtx {
  settings: TallySettings;
  /** Zero-rated (export / SEZ) invoices go to Tally only once calibrated (§9.3); defaults to ZERO_RATED_CALIBRATED. */
  zeroRatedEnabled?: boolean;
  /** the seller profile's default SAC (a line without its own SAC) */
  defaultSac: string;
  /** the party ledger name for a client, or null when no valid name could be made */
  partyLedger: (clientId: string) => string | null;
}

export type Built = { ok: true; v: Voucher } | { ok: false; code: string; message: string };

export const REMOTE_PREFIX: Record<DocType, string> = { invoice: "inv", credit_note: "cn", receipt: "rcpt", refund: "rf" };
export const remoteIdOf = (t: DocType, id: string) => `dsh-${REMOTE_PREFIX[t]}-${id}`;

const firstLine = (s: string | null | undefined) => {
  const l = (s ?? "").split(/\r\n|\r|\n/).map((x) => x.trim()).find((x) => x) ?? "";
  return l || null;
};

/** The registration's voucher types (a per-registration override, else the company default). */
function salesTypeFor(s: TallySettings, gstin: string | null) {
  return s.registrations.find((r) => r.gstin === gstin)?.salesVoucherType ?? s.voucherTypes.sales;
}
function creditTypeFor(s: TallySettings, gstin: string | null) {
  return s.registrations.find((r) => r.gstin === gstin)?.creditNoteVoucherType ?? s.voucherTypes.creditNote;
}
const registrationNameFor = (s: TallySettings, gstin: string | null) => s.registrations.find((r) => r.gstin === gstin)?.registrationName ?? null;

/** "TDS Receivable {fy}" → "TDS Receivable 2026-27" (FY of the day). */
export function tdsLedgerName(template: string, day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return template.split("{fy}").join(`${start}-${String((start + 1) % 100).padStart(2, "0")}`);
}

/** payment mode → the money ledger role and name (§4.4). */
export function moneyLedger(s: TallySettings, mode: string): { kind: "bank" | "cash" | "gateway" | "other"; name: string | null } {
  if (mode === "cash") return { kind: "cash", name: s.ledgers.cash };
  if (mode === "razorpay") return { kind: "gateway", name: s.ledgers.gateway };
  if (mode === "other") return { kind: "other", name: s.ledgers.other };
  return { kind: "bank", name: s.ledgers.bank };
}
const MODE_LEDGER_LABEL: Record<string, string> = { bank: "bank", cash: "cash", gateway: "Razorpay", other: "Other receipts" };
const modeLabel = (mode: string) => (PAYMENT_MODE_LABELS as Record<string, string>)[mode] ?? mode;
const txnTypeOf = (mode: string) => (mode === "cheque" ? "Cheque" : "e-Fund Transfer");

/**
 * Owner 2026-11-05: "No GST" invoices are SEZ / export supplies, billed regularly. Settings carry an
 * "Export / SEZ sales" ledger (ledgers.zeroRatedSales), but such vouchers stay HELD BACK
 * (ZERO_RATED_UNSUPPORTED, listed on the preview) until the accountant's own SEZ/export voucher export
 * is in tests/fixtures/tally/calibration and the calibration test passes (spec §9.3). Flip this
 * constant then — the builder already balances them (tests/sales-tally-xml.test.ts).
 */
export const ZERO_RATED_CALIBRATED = false;

/** Zero-rated: GST mode "none" or a buyer outside India (export / SEZ). */
export const isZeroRated = (inv: InvoiceDoc) => inv.taxMode === "none" || (!!inv.buyer.country && inv.buyer.country.toUpperCase() !== "IN");
const isExport = (inv: InvoiceDoc) => !!inv.buyer.country && inv.buyer.country.toUpperCase() !== "IN";
/** The party's state for Tally: its billing state, else its GSTIN's; an export is "Other Territory". */
function partyStateCode(inv: InvoiceDoc): string | null {
  if (isExport(inv)) return "97";
  return inv.buyer.stateCode || (inv.buyer.gstin ? inv.buyer.gstin.slice(0, 2) : null) || null;
}
const posCodeOf = (inv: InvoiceDoc) => (isExport(inv) ? "97" : inv.placeOfSupplyCode);

/** Sales-ledger shares of an invoice's taxable value: one per distinct ledger, exact (§4.4). */
export function salesShares(inv: InvoiceDoc, ctx: BuildCtx): { ok: true; shares: Array<{ role: string; ledger: string; paise: number; bp: number }> } | { ok: false; code: string; message: string } {
  const s = ctx.settings;
  if (isZeroRated(inv)) {
    if (!(ctx.zeroRatedEnabled ?? ZERO_RATED_CALIBRATED)) {
      return { ok: false, code: "ZERO_RATED_UNSUPPORTED", message: `${inv.number} is without GST (export/SEZ) — held back until the export/SEZ voucher is checked against your accountant's Tally. Enter it in Tally by hand, then mark it as done there.` };
    }
    if (!s.ledgers.zeroRatedSales) {
      return { ok: false, code: "ZERO_RATED_UNSUPPORTED", message: `${inv.number} is without GST (export/SEZ) — set the "Export / SEZ sales" ledger in Tally settings, or enter it in Tally by hand and then mark it as done there.` };
    }
    return { ok: true, shares: [{ role: "sales:zero", ledger: s.ledgers.zeroRatedSales, paise: inv.taxablePaise, bp: 0 }] };
  }
  const groups: Array<{ role: string; ledger: string; weight: number; sac: string }> = [];
  for (const it of inv.items) {
    const sac = it.sac || ctx.defaultSac;
    const led = s.salesLedgers.find((l) => l.sac === sac && l.gstRateBp === inv.gstRateBp);
    if (!led) return { ok: false, code: "NO_SALES_LEDGER", message: `${inv.number} has SAC ${sac} at ${inv.gstRateBp / 100}% — add a sales ledger for it in Tally settings.` };
    const role = `sales:${sac}:${inv.gstRateBp}`;
    const g = groups.find((x) => x.role === role);
    if (g) g.weight += Math.max(0, it.amountPaise);
    else groups.push({ role, ledger: led.name, weight: Math.max(0, it.amountPaise), sac });
  }
  if (!groups.length) {
    const sac = ctx.defaultSac;
    const led = s.salesLedgers.find((l) => l.sac === sac && l.gstRateBp === inv.gstRateBp);
    if (!led) return { ok: false, code: "NO_SALES_LEDGER", message: `${inv.number} has SAC ${sac} at ${inv.gstRateBp / 100}% — add a sales ledger for it in Tally settings.` };
    groups.push({ role: `sales:${sac}:${inv.gstRateBp}`, ledger: led.name, weight: 1, sac });
  }
  const split = splitExact(inv.taxablePaise, groups.map((g) => g.weight));
  return { ok: true, shares: groups.map((g, i) => ({ role: g.role, ledger: g.ledger, paise: split[i], bp: inv.gstRateBp })) };
}

/** Info TALLY_TAX_ROUNDING: with 2+ sales ledgers, Tally's per-ledger tax may differ from the stored tax by a paisa. */
export function taxRoundingDiffers(inv: InvoiceDoc, shares: Array<{ paise: number; bp: number }>): boolean {
  if (shares.length < 2) return false;
  if (inv.taxMode === "intra") return shares.reduce((s, x) => s + Math.round((x.paise * x.bp) / 20_000), 0) !== inv.cgstPaise;
  if (inv.taxMode === "inter") return shares.reduce((s, x) => s + Math.round((x.paise * x.bp) / 10_000), 0) !== inv.igstPaise;
  return false;
}

function invoiceHead(inv: InvoiceDoc, s: TallySettings, reference: { number: string; date: string } | null, withOrder: boolean): NonNullable<Voucher["head"]> {
  const b = inv.buyer;
  const address = [b.addressLine1, b.addressLine2, [b.city, b.pincode].filter(Boolean).join(" ")].map((x) => (x ?? "").trim()).filter(Boolean);
  const gstin = isExport(inv) ? null : (b.gstin || null);
  return {
    buyerName: b.legalName || b.companyName || null,
    address,
    pincode: b.pincode || null,
    stateName: tallyStateName(partyStateCode(inv)),
    country: countryName(b.country),
    registered: !!gstin,
    partyGstin: gstin,
    pos: tallyStateName(posCodeOf(inv)),
    cmpGstin: inv.seller.gstin ?? null,
    cmpState: tallyStateName(inv.seller.stateCode ?? null),
    registrationName: registrationNameFor(s, inv.seller.gstin ?? null),
    reference,
    order: withOrder && inv.poNumber ? { po: inv.poNumber, date: inv.poDate } : null,
  };
}

function baseSubstance(v: Omit<Voucher, "substance">, extra: { pos: string | null; sellerGstin: string | null; ref: [string, string] | null; instrument: Substance["instrument"]; narrationCore: Array<string | null> }): Substance {
  const party = v.entries.find((e) => e.party);
  return {
    v: 1, type: v.docType, number: v.number, date: v.date, cancelled: v.cancelled,
    clientId: v.clientId,
    partyGstin: v.head?.partyGstin ?? null,
    partyRegType: v.head?.registered ? "registered" : "unregistered",
    pos: extra.pos, sellerGstin: extra.sellerGstin,
    entries: v.entries.map((e) => [e.role, e.paise] as [string, number]),
    bills: (party?.bills ?? []).map((b) => [b.type, b.name, b.paise] as [string, string, number]),
    ref: extra.ref, instrument: extra.instrument, narrationCore: extra.narrationCore,
  };
}

function needParty(ctx: BuildCtx, clientId: string, number: string): string | { ok: false; code: string; message: string } {
  const name = ctx.partyLedger(clientId);
  if (!name || !name.trim()) return { ok: false, code: "PARTY_NAME_INVALID", message: `${number}: the client has no usable Tally ledger name — set one on Party ledgers.` };
  return name;
}

// ── Sales ─────────────────────────────────────────────────────────────────────────

export function buildSales(inv: InvoiceDoc, ctx: BuildCtx): Built {
  const s = ctx.settings;
  const party = needParty(ctx, inv.clientId, inv.number);
  if (typeof party !== "string") return party;
  const cancelled = inv.status === "cancelled";
  const voucherType = salesTypeFor(s, inv.seller.gstin ?? null);
  const core = [firstLine(inv.notes) ?? cut(inv.items[0]?.description ?? "", 120), inv.poNumber, inv.poDate, inv.orderNumber, cancelled ? inv.cancelReason : null];
  let narration = core[0] ?? "";
  if (inv.poNumber) narration += ` | PO ${inv.poNumber}${inv.poDate ? ` dt ${dmy(inv.poDate)}` : ""}`;
  if (inv.orderNumber) narration += ` | Order ${inv.orderNumber}`;
  if (inv.irn) narration += ` | IRN ${inv.irn}`;
  const head = invoiceHead(inv, s, null, true);
  const entries: VEntry[] = [];
  if (!cancelled) {
    if (!posCodeOf(inv) || !partyStateCode(inv)) {
      return { ok: false, code: "PLACE_OF_SUPPLY_MISSING", message: `${inv.number}: Tally needs the place of supply — set the client's state and edit the invoice.` };
    }
    const sh = salesShares(inv, ctx);
    if (!sh.ok) return sh;
    entries.push({ role: "party", ledger: party, paise: -inv.totalPaise, party: true, bills: [{ type: "New Ref", name: inv.number, paise: -inv.totalPaise }] });
    for (const x of sh.shares) if (x.paise) entries.push({ role: x.role, ledger: x.ledger, paise: x.paise });
    if (inv.cgstPaise) entries.push({ role: "cgst", ledger: s.ledgers.outputCgst, paise: inv.cgstPaise, duty: true });
    if (inv.sgstPaise) entries.push({ role: "sgst", ledger: s.ledgers.outputSgst, paise: inv.sgstPaise, duty: true });
    if (inv.igstPaise) entries.push({ role: "igst", ledger: s.ledgers.outputIgst, paise: inv.igstPaise, duty: true });
    if (inv.roundOffPaise) entries.push({ role: "roundoff", ledger: s.ledgers.roundOff, paise: inv.roundOffPaise });
  }
  const v: Omit<Voucher, "substance"> = {
    docType: "invoice", docId: inv.id, clientId: inv.clientId, number: inv.number, date: inv.issueDate, remoteId: remoteIdOf("invoice", inv.id),
    voucherType, view: "invoice", cancelled, partyLedger: party, partyPaise: inv.totalPaise, head,
    narration: cut(narration, 500),
    cancelNarration: cut(`Cancelled in the portal${inv.cancelledDay ? ` on ${dmy(inv.cancelledDay)}` : ""}: ${inv.cancelReason ?? "cancelled"}`, 500),
    entries,
  };
  return { ok: true, v: { ...v, substance: baseSubstance(v, { pos: posCodeOf(inv), sellerGstin: inv.seller.gstin ?? null, ref: null, instrument: null, narrationCore: core }) } };
}

// ── Credit note ───────────────────────────────────────────────────────────────────

export function buildCreditNote(cn: CreditNoteDoc, ctx: BuildCtx): Built {
  const s = ctx.settings;
  const inv = cn.invoice;
  const party = needParty(ctx, cn.clientId, cn.number);
  if (typeof party !== "string") return party;
  const cancelled = cn.status === "cancelled";
  const head = invoiceHead(inv, s, { number: inv.number, date: inv.issueDate }, false);
  const entries: VEntry[] = [];
  if (!cancelled) {
    if (!posCodeOf(inv) || !partyStateCode(inv)) {
      return { ok: false, code: "PLACE_OF_SUPPLY_MISSING", message: `${cn.number} (on ${inv.number}): Tally needs the place of supply — set the client's state and edit the invoice.` };
    }
    const sh = salesShares(inv, ctx);
    if (!sh.ok) return { ok: false, code: sh.code, message: sh.code === "NO_SALES_LEDGER" ? sh.message.replace(inv.number, `${cn.number} (on ${inv.number})`) : sh.message.replace(inv.number, `${cn.number} (on ${inv.number})`) };
    // The note's taxable value split by the original invoice's ledger shares, exactly.
    const split = splitExact(cn.taxablePaise, sh.shares.map((x) => Math.max(0, x.paise)));
    const r = cn.totalPaise - cn.taxablePaise - cn.cgstPaise - cn.sgstPaise - cn.igstPaise;
    entries.push({ role: "party", ledger: party, paise: cn.totalPaise, party: true, bills: [{ type: "Agst Ref", name: inv.number, paise: cn.totalPaise }] });
    sh.shares.forEach((x, i) => { if (split[i]) entries.push({ role: x.role, ledger: x.ledger, paise: -split[i] }); });
    if (cn.cgstPaise) entries.push({ role: "cgst", ledger: s.ledgers.outputCgst, paise: -cn.cgstPaise, duty: true });
    if (cn.sgstPaise) entries.push({ role: "sgst", ledger: s.ledgers.outputSgst, paise: -cn.sgstPaise, duty: true });
    if (cn.igstPaise) entries.push({ role: "igst", ledger: s.ledgers.outputIgst, paise: -cn.igstPaise, duty: true });
    if (r) entries.push({ role: "roundoff", ledger: s.ledgers.roundOff, paise: -r });
  }
  const narration = `Against ${inv.number} dt ${dmy(inv.issueDate)} | ${cn.reason}`;
  const v: Omit<Voucher, "substance"> = {
    docType: "credit_note", docId: cn.id, clientId: cn.clientId, number: cn.number, date: cn.issueDate, remoteId: remoteIdOf("credit_note", cn.id),
    voucherType: creditTypeFor(s, inv.seller.gstin ?? null), view: "invoice", cancelled, partyLedger: party, partyPaise: cn.totalPaise, head,
    narration: cut(narration, 500),
    cancelNarration: cut(`Cancelled in the portal${cn.cancelledDay ? ` on ${dmy(cn.cancelledDay)}` : ""}: credit note cancelled`, 500),
    entries,
  };
  return { ok: true, v: { ...v, substance: baseSubstance(v, { pos: posCodeOf(inv), sellerGstin: inv.seller.gstin ?? null, ref: [inv.number, inv.issueDate], instrument: null, narrationCore: [null, null, null, null, cn.reason] }) } };
}

// ── Receipt ───────────────────────────────────────────────────────────────────────

/** §4.3 R1: Agst Ref per tax-invoice allocation (amount + TDS); proforma money and the rest On Account under the receipt's own number. */
export function receiptBills(r: ReceiptDoc): VBill[] {
  const agst = r.allocations
    .filter((a) => a.invoiceKind === "tax_invoice" && a.invoiceNumber && a.amountPaise + a.tdsPaise > 0)
    .map((a) => ({ type: "Agst Ref" as const, name: a.invoiceNumber!, paise: a.amountPaise + a.tdsPaise }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rest = r.amountPaise + r.tdsPaise - agst.reduce((s, b) => s + b.paise, 0);
  return rest > 0 ? [...agst, { type: "On Account", name: r.number, paise: rest }] : agst;
}

export function buildReceipt(r: ReceiptDoc, ctx: BuildCtx): Built {
  const s = ctx.settings;
  const party = needParty(ctx, r.clientId, r.number);
  if (typeof party !== "string") return party;
  const cancelled = r.status !== "recorded";
  const money = moneyLedger(s, r.mode);
  const entries: VEntry[] = [];
  if (!cancelled) {
    if (r.amountPaise > 0 && !money.name) {
      return { ok: false, code: "LEDGER_MISSING", message: `${r.number} was received by ${modeLabel(r.mode)} — set the ${MODE_LEDGER_LABEL[money.kind]} ledger in Tally settings.` };
    }
    const total = r.amountPaise + r.tdsPaise;
    entries.push({ role: "party", ledger: party, paise: total, party: true, bills: receiptBills(r) });
    if (r.amountPaise) {
      entries.push({
        role: `money:${money.kind}`, ledger: money.name!, paise: -r.amountPaise,
        bank: money.kind === "bank" && s.bankAllocations ? { txnType: txnTypeOf(r.mode), instrument: r.reference ? cut(r.reference, 30) : null, favouring: party } : null,
      });
    }
    if (r.tdsPaise) entries.push({ role: "tds", ledger: tdsLedgerName(s.ledgers.tdsReceivable, r.paidOn), paise: -r.tdsPaise });
  }
  let narration = `${modeLabel(r.mode)}${r.reference ? ` ${r.reference}` : ""}`;
  if (r.tdsPaise > 0) narration += ` | TDS ${rsText(r.tdsPaise)} withheld by client`;
  const note = firstLine(r.notes);
  if (note) narration += ` | ${note}`;
  const v: Omit<Voucher, "substance"> = {
    docType: "receipt", docId: r.id, clientId: r.clientId, number: r.number, date: r.paidOn, remoteId: remoteIdOf("receipt", r.id),
    voucherType: s.voucherTypes.receipt, view: "accounting", cancelled, partyLedger: party, partyPaise: r.amountPaise + r.tdsPaise, head: null,
    narration: cut(narration, 500),
    cancelNarration: cut(`Cancelled in the portal${r.voidedDay ? ` on ${dmy(r.voidedDay)}` : ""}: ${r.voidReason ?? "receipt voided"}`, 500),
    entries,
  };
  const instrument: Substance["instrument"] = money.kind === "bank" && r.amountPaise ? [txnTypeOf(r.mode), r.reference ? cut(r.reference, 30) : null, r.paidOn] : null;
  return { ok: true, v: { ...v, substance: baseSubstance(v, { pos: null, sellerGstin: null, ref: null, instrument, narrationCore: [note, null, null, null, r.reference] }) } };
}

// ── Refund → Payment voucher ───────────────────────────────────────────────────────

export function buildRefund(f: RefundDoc, ctx: BuildCtx): Built {
  const s = ctx.settings;
  const party = needParty(ctx, f.clientId, f.number);
  if (typeof party !== "string") return party;
  const cancelled = f.status !== "issued";
  const money = moneyLedger(s, f.mode);
  const entries: VEntry[] = [];
  if (!cancelled) {
    if (!money.name) return { ok: false, code: "LEDGER_MISSING", message: `${f.number} was paid by ${modeLabel(f.mode)} — set the ${MODE_LEDGER_LABEL[money.kind]} ledger in Tally settings.` };
    entries.push({ role: "party", ledger: party, paise: -f.amountPaise, party: true, bills: [{ type: "On Account", name: f.receiptNumber, paise: -f.amountPaise }] });
    entries.push({
      role: `money:${money.kind}`, ledger: money.name, paise: f.amountPaise,
      bank: money.kind === "bank" && s.bankAllocations ? { txnType: txnTypeOf(f.mode), instrument: f.reference ? cut(f.reference, 30) : null, favouring: party } : null,
    });
  }
  let narration = `Refund of ${f.receiptNumber} | ${modeLabel(f.mode)}${f.reference ? ` ${f.reference}` : ""}`;
  const note = firstLine(f.notes);
  if (note) narration += ` | ${note}`;
  const v: Omit<Voucher, "substance"> = {
    docType: "refund", docId: f.id, clientId: f.clientId, number: f.number, date: f.refundedOn, remoteId: remoteIdOf("refund", f.id),
    voucherType: s.voucherTypes.payment, view: "accounting", cancelled, partyLedger: party, partyPaise: f.amountPaise, head: null,
    narration: cut(narration, 500),
    cancelNarration: cut(`Cancelled in the portal${f.cancelledDay ? ` on ${dmy(f.cancelledDay)}` : ""}: refund cancelled`, 500),
    entries,
  };
  const instrument: Substance["instrument"] = money.kind === "bank" ? [txnTypeOf(f.mode), f.reference ? cut(f.reference, 30) : null, f.refundedOn] : null;
  return { ok: true, v: { ...v, substance: baseSubstance(v, { pos: null, sellerGstin: null, ref: [f.receiptNumber, ""], instrument, narrationCore: [note, null, null, null, f.reference] }) } };
}

export function buildDoc(d: AnyDoc, ctx: BuildCtx): Built {
  switch (d.docType) {
    case "invoice": return buildSales(d.doc, ctx);
    case "credit_note": return buildCreditNote(d.doc, ctx);
    case "receipt": return buildReceipt(d.doc, ctx);
    case "refund": return buildRefund(d.doc, ctx);
  }
}

// ── Invariants, hash ──────────────────────────────────────────────────────────────

/** I2: Σ AMOUNT = 0 and the bills sum to the party amount. A failure is a bug: throw, store nothing. */
export function assertBalanced(v: Voucher): void {
  if (v.cancelled) { if (v.entries.length) throw new Error(`[tally] cancelled ${v.number} has ledger entries`); return; }
  const sum = v.entries.reduce((s, e) => s + e.paise, 0);
  if (sum !== 0) throw new Error(`[tally] ${v.number} does not balance (Σ = ${sum} paise)`);
  for (const e of v.entries) {
    if (!Number.isSafeInteger(e.paise) || e.paise === 0) throw new Error(`[tally] ${v.number}: a zero or non-integer entry (${e.role})`);
    if (e.bills) {
      const b = e.bills.reduce((s, x) => s + x.paise, 0);
      if (b !== e.paise) throw new Error(`[tally] ${v.number}: bills ${b} ≠ party ${e.paise}`);
    }
  }
  const party = v.entries.filter((e) => e.party);
  if (party.length !== 1) throw new Error(`[tally] ${v.number}: expected exactly one party entry`);
}

export function canonicalJSON(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonicalJSON).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`).join(",")}}`;
}
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const contentHash = (v: Voucher) => sha256(canonicalJSON(v.substance));

// ── Rendering ─────────────────────────────────────────────────────────────────────

export type RenderAction = "Create" | "Alter" | "Cancel";
const yn = (b: boolean) => (b ? "Yes" : "No");

/** One voucher as a TALLYMESSAGE block (depth 4), for `action`. Release decides the unregistered wording. */
export function renderVoucher(v: Voucher, action: RenderAction, release: "prime3" | "legacy"): string {
  const w = new XmlWriter(4);
  w.open("TALLYMESSAGE", [["xmlns:UDF", "TallyUDF"]]);
  if (action === "Cancel") {
    w.open("VOUCHER", [["DATE", tallyDate(v.date)], ["TAGNAME", "Voucher Number"], ["TAGVALUE", v.number], ["VCHTYPE", v.voucherType], ["ACTION", "Cancel"]]);
    w.leaf("NARRATION", v.cancelNarration);
    w.close("VOUCHER").close("TALLYMESSAGE");
    return w.toString();
  }
  const view = v.view === "invoice" ? "Invoice Voucher View" : "Accounting Voucher View";
  w.open("VOUCHER", [["REMOTEID", v.remoteId], ["VCHTYPE", v.voucherType], ["ACTION", action], ["OBJVIEW", view]]);
  w.leaf("DATE", tallyDate(v.date)).leaf("EFFECTIVEDATE", tallyDate(v.date)).leaf("VOUCHERTYPENAME", v.voucherType).leaf("VOUCHERNUMBER", v.number);
  if (v.head?.reference) w.leaf("REFERENCE", v.head.reference.number).leaf("REFERENCEDATE", tallyDate(v.head.reference.date));
  w.leaf("PERSISTEDVIEW", view);
  if (v.view === "invoice") w.leaf("VCHENTRYMODE", "Accounting Invoice");
  w.leaf("ISINVOICE", yn(v.view === "invoice"));
  w.leaf("PARTYLEDGERNAME", v.partyLedger);
  if (v.cancelled) {
    w.leaf("ISCANCELLED", "Yes").leaf("NARRATION", v.cancelNarration);
    w.close("VOUCHER").close("TALLYMESSAGE");
    return w.toString();
  }
  const h = v.head;
  if (h) {
    w.leaf("PARTYNAME", v.partyLedger).leaf("BASICBUYERNAME", h.buyerName ?? v.partyLedger);
    if (v.docType === "invoice") {
      w.leaf("PARTYMAILINGNAME", h.buyerName ?? v.partyLedger);
      if (h.address.length) { w.open("ADDRESS.LIST", [["TYPE", "String"]]); for (const a of h.address) w.leaf("ADDRESS", a); w.close("ADDRESS.LIST"); }
      w.leaf("PARTYPINCODE", h.pincode);
    }
    w.leaf("STATENAME", h.stateName).leaf("COUNTRYOFRESIDENCE", h.country);
    w.leaf("GSTREGISTRATIONTYPE", h.registered ? "Regular" : release === "prime3" ? "Unregistered/Consumer" : "Unregistered");
    w.leaf("PARTYGSTIN", h.partyGstin);
    w.leaf("PLACEOFSUPPLY", h.pos);
    w.leaf("CMPGSTIN", h.cmpGstin).leaf("CMPGSTSTATE", h.cmpState).leaf("CMPGSTREGISTRATIONTYPE", "Regular");
    if (release === "prime3" && h.registrationName && h.cmpGstin) w.leaf("GSTREGISTRATION", h.registrationName, [["TAXTYPE", "GST"], ["TAXREGISTRATION", h.cmpGstin]]);
    if (h.order) {
      w.open("INVOICEORDERLIST.LIST");
      if (h.order.date) w.leaf("BASICORDERDATE", tallyDate(h.order.date));
      w.leaf("BASICPURCHASEORDERNO", h.order.po);
      w.close("INVOICEORDERLIST.LIST");
    }
  }
  w.leaf("NARRATION", v.narration);
  const list = v.view === "invoice" ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST";
  for (const e of v.entries) {
    w.open(list);
    w.leaf("LEDGERNAME", e.ledger).leaf("ISDEEMEDPOSITIVE", yn(e.paise < 0)).leaf("ISPARTYLEDGER", yn(!!e.party)).leaf("AMOUNT", amt(e.paise));
    if (e.duty) w.leaf("VATEXPAMOUNT", amt(e.paise));
    for (const b of e.bills ?? []) {
      w.open("BILLALLOCATIONS.LIST").leaf("NAME", b.name).leaf("BILLTYPE", b.type).leaf("AMOUNT", amt(b.paise)).close("BILLALLOCATIONS.LIST");
    }
    if (e.bank) {
      w.open("BANKALLOCATIONS.LIST");
      w.leaf("DATE", tallyDate(v.date)).leaf("INSTRUMENTDATE", tallyDate(v.date)).leaf("TRANSACTIONTYPE", e.bank.txnType);
      w.leaf("INSTRUMENTNUMBER", e.bank.instrument).leaf("PAYMENTFAVOURING", e.bank.favouring).leaf("AMOUNT", amt(e.paise));
      w.close("BANKALLOCATIONS.LIST");
    }
    w.close(list);
  }
  w.close("VOUCHER").close("TALLYMESSAGE");
  return w.toString();
}
