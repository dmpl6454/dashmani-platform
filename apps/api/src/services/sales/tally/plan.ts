import type { CompanyKey, TallyDocType, TallyMode, TallyRelease } from "@dashmani/shared";
import { financialYear } from "@dashmani/shared";
import { renderAccountLedger, renderPartyLedger, accountLedgerGroup, type AccountLedgerKind, type PartyMaster } from "./masters";
import {
  assertBalanced, buildDoc, contentHash, renderVoucher, salesShares, sha256, taxRoundingDiffers, tdsLedgerName,
  type AnyDoc, type CreditNoteDoc, type InvoiceDoc, type ReceiptDoc, type RefundDoc, type TallySettings, type Voucher,
} from "./vouchers";
import { importEnvelope } from "./xml";

// The pure planner (spec-tally §4.3, §4.4, §4.10–4.12). It turns what collect.ts read into one plan
// row per selected document — create / alter / cancel / unchanged / skip / blocked (invariant I3) —
// pulls in the invoices a receipt or credit note needs, raises the issue catalogue, totals what
// "Tally should show", and fingerprints the whole thing (previewHash, I6). No I/O, no clock.

export type TallyAction = "create" | "alter" | "cancel" | "unchanged" | "skip" | "blocked";
export type RowReason = "new" | "changed" | "resend" | "cancelled" | "needed" | "earlier_change" | null;
export type Severity = "block" | "ack" | "info";

export interface TallyIssue {
  id: string; code: string; severity: Severity;
  docType?: TallyDocType; docId?: string; number?: string;
  message: string;
  fix?: { href: string; label: string };
}

export interface PlanDoc {
  d: AnyDoc;
  /** the seller GSTIN this document routes by (§4.3 R5 for receipts and refunds) */
  routeGstin: string | null;
  /** the Tally company that GSTIN maps to (null = no registration mapping) */
  tallyCompany: string | null;
  /** period = selected by date; earlier = nominated by the change detector; candidate = an invoice a receipt / credit note may need */
  origin: "period" | "earlier" | "candidate";
}

export interface LastGood { action: string; contentHash: string | null; partyAmountPaise: number; runNo: number; at: string; runId: string }
export interface PartyMapping { clientId: string; ledgerName: string; ledgerKey: string; gstin: string | null; existsInTally: boolean; lockedAt: string | null }
export interface ClientInfo {
  id: string; companyName: string; legalName: string | null; gstin: string | null; pan: string | null;
  addressLine1: string | null; addressLine2: string | null; city: string | null; pincode: string | null; stateCode: string | null; country: string | null;
}

export interface PlanInput {
  company: CompanyKey;
  tallyCompany: string;
  scopeGstin: string | null;
  /** the registrations (GSTINs) in scope */
  scopeGstins: string[];
  registrations: Array<{ gstin: string; label: string; state: string }>;
  release: TallyRelease;
  mode: TallyMode;
  from: string; to: string; effectiveFrom: string; booksFrom: string;
  /** IST today (late-change checks only) */
  today: string;
  settings: TallySettings;
  defaultSac: string;
  zeroRatedEnabled?: boolean;
  docs: PlanDoc[];
  lastGood: Map<string, LastGood>;
  /** the company's party mappings (all of them: proposals must not collide with any) */
  mappings: PartyMapping[];
  clients: Map<string, ClientInfo>;
  beforeBooks: number;
  openRun: { id: string; runNo: number; status: string } | null;
  firstExport: boolean;
  settingsUpdatedAt: string;
  stateVersion: string;
}

export interface PlanRow {
  docType: TallyDocType; docId: string; number: string; date: string; clientId: string; party: string;
  partyAmountPaise: number; action: TallyAction; reason: RowReason;
  voucher: Voucher | null; hash: string | null; blockCode: string | null; blockMessage: string | null;
  issueIds: string[]; lastSent: { runNo: number; at: string; action: string } | null;
  /** invoice doc ids (in this plan) this row needs in Tally first */
  dependsOn: string[];
}

type Gst = { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
export interface Plan {
  rows: PlanRow[];
  /** rows that go into the file, in file order */
  runRows: PlanRow[];
  issues: TallyIssue[];
  parties: Map<string, { name: string; proposed: boolean; write: boolean }>;
  partyMasters: PartyMaster[];
  accountLedgers: Array<{ name: string; kind: AccountLedgerKind }>;
  counts: Record<string, unknown> & { vouchers: number; blocked: number };
  totals: Record<string, number>;
  tallyShouldShow: { gst: unknown[]; tds: Array<{ fy: string; ledger: string; paise: number; receipts: number }> };
  ledgers: Array<{ role: string; name: string; group: string | null; createdByExport: boolean; debitPaise: number; creditPaise: number }>;
  previewHash: string;
  controlTotalPaise: number;
}

// ── Party ledger names (§4.4) ─────────────────────────────────────────────────────

/** Tally names are case-insensitive: lower-case, whitespace collapsed. */
export const ledgerKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();
const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cutTo = (s: string, n: number) => (Array.from(s).length <= n ? s : Array.from(s).slice(0, n).join("").trim());

/**
 * The proposed Tally ledger name for a client: its billing legal name (else company name), cut to
 * 100. On a collision with another client of a different (or no) GSTIN, or with an account ledger,
 * a suffix is tried in turn: " (<GSTIN>)", " (<city>)", " (<id first 8>)". Same GSTIN = same party,
 * so those clients may share the name. null = no usable name (PARTY_NAME_INVALID).
 */
export function proposeLedgerName(
  c: { id: string; legalName: string | null; companyName: string; gstin: string | null; city: string | null },
  taken: Array<{ key: string; gstin: string | null; clientId: string }>,
  accountKeys: Set<string>,
): string | null {
  const base = collapse(c.legalName || c.companyName);
  if (!base) return null;
  const collides = (name: string) => {
    const k = ledgerKey(name);
    return accountKeys.has(k) || taken.some((t) => t.key === k && t.clientId !== c.id && !(c.gstin && t.gstin === c.gstin));
  };
  const first = cutTo(base, 100);
  if (!collides(first)) return first;
  const suffixes = [c.gstin, collapse(c.city) || null, c.id.slice(0, 8)].filter((x): x is string => !!x);
  for (const sfx of suffixes) {
    const tail = ` (${sfx})`;
    const name = `${cutTo(base, 100 - Array.from(tail).length)}${tail}`;
    if (!collides(name)) return name;
  }
  return null;
}

/** Account-ledger names configured in settings (a party name may never equal one). */
export function accountLedgerKeys(s: TallySettings): Set<string> {
  const names = [...s.salesLedgers.map((l) => l.name), s.ledgers.outputCgst, s.ledgers.outputSgst, s.ledgers.outputIgst, s.ledgers.roundOff,
    s.ledgers.tdsReceivable.replace("{fy}", "").trim(), s.ledgers.bank, s.ledgers.cash, s.ledgers.gateway, s.ledgers.other, s.ledgers.zeroRatedSales];
  return new Set(names.filter((n): n is string => !!n).map(ledgerKey));
}

// ── GST deadlines ─────────────────────────────────────────────────────────────────

/** GSTR-1 due day for a document day: 11th of next month (monthly) or 13th of the month after the FY quarter (quarterly). */
export function gstr1DueDay(day: string, filing: "monthly" | "quarterly"): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  let dm: number;
  let dd: string;
  if (filing === "monthly") { dm = m + 1; dd = "11"; } else { dm = Math.ceil(m / 3) * 3 + 1; dd = "13"; }
  const yy = dm > 12 ? y + 1 : y;
  const mm = dm > 12 ? dm - 12 : dm;
  return `${yy}-${String(mm).padStart(2, "0")}-${dd}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
/** s.34(2): a credit note after 30 November following the end of the invoice's FY may not reduce output tax. */
export const cnDeadline = (invoiceDay: string) => `${Number(financialYear(invoiceDay).startDay.slice(0, 4)) + 1}-11-30`;

// ── Helpers ───────────────────────────────────────────────────────────────────────

const docOf = (d: AnyDoc) => d.doc as InvoiceDoc & CreditNoteDoc & ReceiptDoc & RefundDoc;
function basics(d: AnyDoc): { number: string; date: string; clientId: string; cancelled: boolean; partyAmountPaise: number } {
  switch (d.docType) {
    case "invoice": return { number: d.doc.number, date: d.doc.issueDate, clientId: d.doc.clientId, cancelled: d.doc.status === "cancelled", partyAmountPaise: d.doc.totalPaise };
    case "credit_note": return { number: d.doc.number, date: d.doc.issueDate, clientId: d.doc.clientId, cancelled: d.doc.status === "cancelled", partyAmountPaise: d.doc.totalPaise };
    case "receipt": return { number: d.doc.number, date: d.doc.paidOn, clientId: d.doc.clientId, cancelled: d.doc.status !== "recorded", partyAmountPaise: d.doc.amountPaise + d.doc.tdsPaise };
    case "refund": return { number: d.doc.number, date: d.doc.refundedOn, clientId: d.doc.clientId, cancelled: d.doc.status !== "issued", partyAmountPaise: d.doc.amountPaise };
  }
}
const GROUP_ORDER: Record<TallyDocType, number> = { invoice: 0, credit_note: 1, receipt: 2, refund: 3 };
const issueId = (code: string, docId?: string) => `${code}:${docId ?? "-"}`;
const isBlocked = (r: PlanRow) => r.action === "blocked";
const inRun = (a: TallyAction) => a === "create" || a === "alter" || a === "cancel";
const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function roleKind(role: string): AccountLedgerKind | null {
  if (role.startsWith("sales:")) return "sales";
  if (role === "cgst" || role === "sgst" || role === "igst" || role === "roundoff" || role === "tds") return role;
  if (role.startsWith("money:")) return role.slice(6) as AccountLedgerKind;
  return null;
}

/** The rendered voucher for a row's action. */
export function renderRow(r: PlanRow, release: TallyRelease): string {
  if (!r.voucher) throw new Error(`[tally] ${r.number} has no voucher`);
  return renderVoucher(r.voucher, r.action === "cancel" ? "Cancel" : r.action === "alter" ? "Alter" : "Create", release);
}

// ── The planner ───────────────────────────────────────────────────────────────────

export function planTally(input: PlanInput): Plan {
  const s = input.settings;
  const accountKeys = accountLedgerKeys(s);
  const mappingByClient = new Map(input.mappings.map((m) => [m.clientId, m]));

  // 1. Party names for every client any document needs, proposals made in a stable order.
  const parties = new Map<string, { name: string; proposed: boolean; write: boolean }>();
  const taken = input.mappings.map((m) => ({ key: m.ledgerKey, gstin: m.gstin, clientId: m.clientId }));
  const clientIds = [...new Set(input.docs.map((p) => basics(p.d).clientId))].sort();
  for (const id of clientIds) {
    const m = mappingByClient.get(id);
    if (m) { parties.set(id, { name: m.ledgerName, proposed: false, write: !m.existsInTally && !m.lockedAt }); continue; }
    const c = input.clients.get(id);
    const name = c ? proposeLedgerName(c, taken, accountKeys) : null;
    if (name) {
      parties.set(id, { name, proposed: true, write: true });
      taken.push({ key: ledgerKey(name), gstin: c!.gstin, clientId: id });
    }
  }
  const ctx = { settings: s, defaultSac: input.defaultSac, zeroRatedEnabled: input.zeroRatedEnabled, partyLedger: (id: string) => parties.get(id)?.name ?? null };

  // 2. Build every document and decide its action (§4.3 table).
  const rows: PlanRow[] = [];
  const byId = new Map<string, PlanRow>();
  const candidates = new Map<string, PlanRow>();
  for (const p of input.docs) {
    const b = basics(p.d);
    const built = buildDoc(p.d, ctx);
    const last = input.lastGood.get(p.d.doc.id) ?? null;
    const voucher = built.ok ? built.v : null;
    if (voucher) assertBalanced(voucher);
    const hash = voucher ? contentHash(voucher) : null;
    const row: PlanRow = {
      docType: p.d.docType, docId: p.d.doc.id, number: b.number, date: b.date, clientId: b.clientId, party: parties.get(b.clientId)?.name ?? "—",
      partyAmountPaise: b.partyAmountPaise, action: "unchanged", reason: null, voucher, hash,
      blockCode: built.ok ? null : built.code, blockMessage: built.ok ? null : built.message, issueIds: [],
      lastSent: last ? { runNo: last.runNo, at: last.at, action: last.action } : null, dependsOn: [],
    };
    const earlier = p.origin === "earlier";
    if (!last) {
      if (b.cancelled) {
        row.action = p.d.docType === "invoice" || p.d.docType === "credit_note" ? "create" : "skip";
        row.reason = row.action === "create" ? "cancelled" : null;
      } else {
        row.action = "create";
        row.reason = "new";
      }
    } else if (last.action === "cancel") {
      row.action = "unchanged";
    } else if (b.cancelled) {
      row.action = "cancel";
      row.reason = earlier ? "earlier_change" : "cancelled";
    } else if (hash !== last.contentHash) {
      row.action = "alter";
      row.reason = earlier ? "earlier_change" : "changed";
    } else {
      row.action = input.mode === "everything" && !earlier ? "alter" : "unchanged";
      row.reason = row.action === "alter" ? "resend" : null;
    }
    // A document that has to be written but could not be built is blocked. A Cancel needs no entries.
    if (!built.ok && (row.action === "create" || row.action === "alter")) {
      // Resolved by hand earlier (a manual item of a document the portal cannot build, e.g. export/SEZ):
      // Tally already matches, so it is not blocked again.
      row.action = last && last.contentHash === null && !b.cancelled ? "unchanged" : "blocked";
      if (row.action === "unchanged") row.reason = null;
    }
    if (!built.ok && row.action === "cancel") row.action = "blocked"; // only an unusable party name stops a Cancel
    if (p.origin === "candidate") { candidates.set(row.docId, row); continue; }
    if (earlier && (row.action === "unchanged" || row.action === "skip")) continue; // nominated but not changed
    rows.push(row);
    byId.set(row.docId, row);
  }

  const issues = new Map<string, TallyIssue>();
  const addIssue = (row: PlanRow | null, code: string, severity: Severity, message: string, fix?: TallyIssue["fix"]) => {
    const id = issueId(code, row?.docId);
    if (!issues.has(id)) issues.set(id, { id, code, severity, message, ...(row ? { docType: row.docType, docId: row.docId, number: row.number } : {}), ...(fix ? { fix } : {}) });
    if (row && !row.issueIds.includes(id)) row.issueIds.push(id);
  };
  const block = (row: PlanRow, code: string, message: string) => {
    row.action = "blocked";
    row.blockCode = code;
    row.blockMessage = message;
  };

  // 3. Dependencies: Agst Ref invoices (R2, R3, R4) and the receipt of a refund.
  const tallyHas = (invoiceId: string) => { const l = input.lastGood.get(invoiceId); return !!l && l.action !== "cancel"; };
  const docById = new Map(input.docs.map((p) => [p.d.doc.id, p]));
  /** null = fine; else the blocking invoice number */
  const need = (dependant: PlanRow, invoiceId: string, invoiceNumber: string, invoiceDay: string | null): string | null => {
    if (invoiceDay && invoiceDay < input.booksFrom) {
      addIssue(dependant, "REFERS_UNEXPORTED_INVOICE", "info", `${dependant.number} is against ${invoiceNumber}, dated before ${input.booksFrom} — Tally is assumed to hold it under the same number.`);
      return null;
    }
    const inPlan = byId.get(invoiceId);
    if (inPlan) {
      if (inPlan.action === "blocked") return invoiceNumber;
      if (inPlan.action === "create" || inPlan.action === "alter") dependant.dependsOn.push(invoiceId);
      return null;
    }
    if (tallyHas(invoiceId)) return null;
    const cand = candidates.get(invoiceId);
    if (!cand) return null; // not loadable here (other company / pre-books): nothing to pull in
    const cdoc = docById.get(invoiceId)!;
    if (cdoc.tallyCompany !== input.tallyCompany) return null;
    cand.reason = "needed";
    if (cand.action !== "blocked") cand.action = "create";
    rows.push(cand);
    byId.set(cand.docId, cand);
    candidates.delete(invoiceId);
    if (cand.action === "blocked") return invoiceNumber;
    dependant.dependsOn.push(invoiceId);
    return null;
  };
  for (const row of [...rows]) {
    if (row.action !== "create" && row.action !== "alter") continue;
    const p = docById.get(row.docId)!;
    if (row.docType === "credit_note") {
      const cn = p.d.doc as CreditNoteDoc;
      const bad = need(row, cn.invoice.id, cn.invoice.number, cn.invoice.issueDate);
      if (bad && !isBlocked(row)) block(row, "DEPENDS_ON_UNSENT", `${row.number} is against ${bad}, which can't go to Tally yet — fix that invoice first.`);
      if (cn.issueDate > cnDeadline(cn.invoice.issueDate)) {
        addIssue(row, "CN_AFTER_GST_DEADLINE", "info", `${row.number} is dated after 30 Nov following ${cn.invoice.number}'s financial year — s.34(2): it reduces the receivable but may not reduce output tax. Ask your CA.`);
      }
    } else if (row.docType === "receipt") {
      const r = p.d.doc as ReceiptDoc;
      const live = r.allocations.filter((a) => a.invoiceKind === "tax_invoice" && a.invoiceNumber && a.amountPaise + a.tdsPaise > 0);
      const companies = new Set(live.map((a) => docById.get(a.invoiceId)?.tallyCompany ?? null).filter((x) => x !== null));
      if (companies.size > 1) {
        block(row, "RECEIPT_SPANS_COMPANIES", `${row.number} pays invoices of two Tally companies — enter it in Tally by hand, then mark it as done there.`);
        continue;
      }
      for (const a of live) {
        const bad = need(row, a.invoiceId, a.invoiceNumber!, a.invoiceDate);
        if (bad && !isBlocked(row)) block(row, "DEPENDS_ON_UNSENT", `${row.number} pays ${bad}, which can't go to Tally yet — fix that invoice first.`);
      }
    } else if (row.docType === "refund") {
      const f = p.d.doc as RefundDoc;
      const rc = byId.get(f.paymentId);
      if (rc?.action === "blocked" && !isBlocked(row)) block(row, "DEPENDS_ON_UNSENT", `${row.number} refunds ${f.receiptNumber}, which can't go to Tally yet — fix that receipt first.`);
      else if (rc && (rc.action === "create" || rc.action === "alter")) row.dependsOn.push(rc.docId);
    }
  }

  // 4. The issue catalogue.
  const filing = s.gstr1Filing;
  for (const row of rows) {
    const p = docById.get(row.docId)!;
    if (row.action === "blocked") {
      const fix = row.blockCode === "NO_SALES_LEDGER" || row.blockCode === "LEDGER_MISSING" ? { href: "/tally/settings", label: "Open Tally settings" }
        : row.blockCode === "PARTY_NAME_INVALID" ? { href: "/tally/parties", label: "Open party ledgers" } : undefined;
      addIssue(row, row.blockCode ?? "BLOCKED", "block", row.blockMessage ?? `${row.number} can't go to Tally yet.`, fix);
      continue;
    }
    if (row.action === "skip") {
      addIssue(row, "VOIDED_NEVER_SENT", "info", `${row.number} was ${row.docType === "receipt" ? "voided" : "cancelled"} before it ever went to Tally — nothing to send.`);
      continue;
    }
    if (!inRun(row.action)) continue;
    const isGst = row.docType === "invoice" || row.docType === "credit_note";
    if (isGst) {
      const due = gstr1DueDay(row.date, filing);
      const cancelling = row.action === "cancel" || row.reason === "cancelled";
      if (cancelling) {
        const doc = docOf(p.d);
        const when = doc.cancelledDay ?? input.today;
        if (when > due) addIssue(row, "LATE_CANCELLATION", "ack", `${row.number} (${monthLabel(row.date)}) was cancelled after ${monthLabel(row.date).split(" ")[0]}'s GSTR-1 due date (${dayLabel(due)}). If that GSTR-1 included it, cancelling is no longer valid — a credit note is. Ask your CA before importing.`);
      } else if (row.action === "alter" && row.reason !== "resend" && input.today > due) {
        addIssue(row, "LATE_ALTERATION", "ack", `${row.number} (${monthLabel(row.date)}) changed after its GSTR-1 due date (${dayLabel(due)}) — if it was reported, amend it in the next GSTR-1 (Table 9A).`);
      }
    }
    if (row.docType === "invoice" && row.voucher && !row.voucher.cancelled) {
      const inv = p.d.doc as InvoiceDoc;
      const sh = salesShares(inv, ctx);
      if (sh.ok && taxRoundingDiffers(inv, sh.shares)) addIssue(row, "TALLY_TAX_ROUNDING", "info", `Tally may show a ₹0.01 tax difference on ${row.number} (two sales ledgers, tax rounded per ledger).`);
    }
    if (row.docType === "receipt" && row.voucher && !row.voucher.cancelled) {
      const party = row.voucher.entries.find((e) => e.party);
      const onAcc = party?.bills?.find((x) => x.type === "On Account");
      if (onAcc) {
        const c = input.clients.get(row.clientId);
        addIssue(row, "ADVANCE_RECEIVED", "info", `${rupees(onAcc.paise)} from ${c?.legalName ?? c?.companyName ?? row.party} on ${row.number} isn't against a tax invoice — Tally records it On Account. GST on advances for services may be due (CGST s.13); ask your CA.`);
      }
    }
  }

  // 5. File order: Sales, Credit Notes, Receipts, Payments; by date then number; cancels last.
  const runRows = rows.filter((r) => inRun(r.action)).sort((a, b) =>
    GROUP_ORDER[a.docType] - GROUP_ORDER[b.docType]
    || Number(a.action === "cancel") - Number(b.action === "cancel")
    || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  const vouchers = runRows.length;

  // 6. Masters: parties the run's vouchers name (never for a Cancel), new and not already in Tally.
  const usedParties = new Set(runRows.filter((r) => r.action !== "cancel").map((r) => r.clientId));
  const partyMasters: PartyMaster[] = [];
  for (const id of [...usedParties].sort()) {
    const pm = parties.get(id);
    const c = input.clients.get(id);
    if (!pm || !pm.write || !c) continue;
    partyMasters.push({
      name: pm.name, group: s.partyGroup, mailingName: c.legalName || c.companyName, gstin: c.gstin, pan: c.pan,
      addressLine1: c.addressLine1, addressLine2: c.addressLine2, city: c.city, pincode: c.pincode, stateCode: c.stateCode, country: c.country,
    });
  }
  // PARTY_DETAILS_CHANGED: a mapped ledger whose client's GSTIN changed since it was made.
  for (const id of usedParties) {
    const m = mappingByClient.get(id);
    const c = input.clients.get(id);
    if (m && c && (m.lockedAt || m.existsInTally) && (m.gstin ?? null) !== (c.gstin ?? null)) {
      const iid = issueId("PARTY_DETAILS_CHANGED", id);
      issues.set(iid, { id: iid, code: "PARTY_DETAILS_CHANGED", severity: "info", message: `${m.ledgerName}'s GSTIN changed since its Tally ledger was created — update the ledger in Tally by hand.` });
    }
  }

  // 7. Ledgers, totals, control total.
  const ledgerAgg = new Map<string, { role: string; name: string; kind: AccountLedgerKind; debitPaise: number; creditPaise: number }>();
  let partyDr = 0;
  let partyCr = 0;
  const totals = {
    salesTaxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, salesTotalPaise: 0, creditTotalPaise: 0,
    receiptCashPaise: 0, tdsPaise: 0, refundPaise: 0, controlTotalPaise: 0,
  };
  for (const r of runRows) {
    const v = r.voucher!;
    if (r.action === "cancel" || v.cancelled) continue;
    for (const e of v.entries) {
      if (e.paise < 0) totals.controlTotalPaise += -e.paise;
      if (e.party) { if (e.paise < 0) partyDr += -e.paise; else partyCr += e.paise; continue; }
      const kind = roleKind(e.role);
      if (!kind) continue;
      const key = `${kind}|${ledgerKey(e.ledger)}`;
      const a = ledgerAgg.get(key) ?? { role: e.role.startsWith("sales:") ? "sales" : e.role, name: e.ledger, kind, debitPaise: 0, creditPaise: 0 };
      if (e.paise < 0) a.debitPaise += -e.paise; else a.creditPaise += e.paise;
      ledgerAgg.set(key, a);
    }
    const p = docById.get(r.docId)!;
    if (r.docType === "invoice") {
      const inv = p.d.doc as InvoiceDoc;
      totals.salesTaxablePaise += inv.taxablePaise; totals.cgstPaise += inv.cgstPaise; totals.sgstPaise += inv.sgstPaise; totals.igstPaise += inv.igstPaise;
      totals.roundOffPaise += inv.roundOffPaise; totals.salesTotalPaise += inv.totalPaise;
    } else if (r.docType === "credit_note") totals.creditTotalPaise += (p.d.doc as CreditNoteDoc).totalPaise;
    else if (r.docType === "receipt") { const rc = p.d.doc as ReceiptDoc; totals.receiptCashPaise += rc.amountPaise; totals.tdsPaise += rc.tdsPaise; }
    else totals.refundPaise += (p.d.doc as RefundDoc).amountPaise;
  }
  const accountLedgers = s.createAccountLedgers ? [...ledgerAgg.values()].map((a) => ({ name: a.name, kind: a.kind })) : [];
  const ledgers = [
    ...(usedParties.size ? [{ role: "parties", name: `${usedParties.size} client ledger${usedParties.size === 1 ? "" : "s"}`, group: s.partyGroup, createdByExport: partyMasters.length > 0, debitPaise: partyDr, creditPaise: partyCr }] : []),
    ...[...ledgerAgg.values()].map((a) => ({ role: a.role, name: a.name, group: accountLedgerGroup(a.kind), createdByExport: s.createAccountLedgers, debitPaise: a.debitPaise, creditPaise: a.creditPaise })),
  ];

  // 8. Run-level issues.
  const earlierChanges = rows.filter((r) => r.reason === "earlier_change").length;
  if (earlierChanges) addIssue(null, "EARLIER_CHANGES", "info", `${earlierChanges} voucher${earlierChanges === 1 ? "" : "s"} from earlier months changed after ${earlierChanges === 1 ? "it was" : "they were"} sent and ${earlierChanges === 1 ? "is" : "are"} included as updates.`);
  if (input.beforeBooks) addIssue(null, "BEFORE_BOOKS_EXCLUDED", "info", `${input.beforeBooks} document${input.beforeBooks === 1 ? "" : "s"} before ${input.booksFrom} ${input.beforeBooks === 1 ? "is" : "are"} left out — Tally already has them.`);
  if (input.firstExport && vouchers > 0) addIssue(null, "FIRST_EXPORT_OVERLAP", "ack", `This is the first export into "${input.tallyCompany}". If any of these are already in Tally (typed by hand or synced from Swipe), set 'Tally already has everything before' past them first. Voucher types set to Prevent Duplicates will refuse them.`);

  // 9. "After importing, Tally should show" — every live document of the period in scope, any mode.
  const regLabel = new Map(input.registrations.map((r) => [r.gstin, r.label]));
  const gstRows = new Map<string, { gstin: string; label: string; month: string; b2b: Gst; b2c: Gst; creditNotes: Gst; documents: { issued: number; cancelled: number; fromNo: string | null; toNo: string | null } }>();
  const zero = (): Gst => ({ count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  const bucket = (gstin: string, day: string) => {
    const key = `${gstin}|${day.slice(0, 7)}`;
    let g = gstRows.get(key);
    if (!g) { g = { gstin, label: regLabel.get(gstin) ?? gstin, month: day.slice(0, 7), b2b: zero(), b2c: zero(), creditNotes: zero(), documents: { issued: 0, cancelled: 0, fromNo: null, toNo: null } }; gstRows.set(key, g); }
    return g;
  };
  const add = (g: Gst, x: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }) => {
    g.count += 1; g.taxablePaise += x.taxablePaise; g.cgstPaise += x.cgstPaise; g.sgstPaise += x.sgstPaise; g.igstPaise += x.igstPaise;
  };
  const tds = new Map<string, { fy: string; ledger: string; paise: number; receipts: number }>();
  for (const p of input.docs) {
    if (p.origin !== "period" || p.tallyCompany !== input.tallyCompany) continue;
    if (p.d.docType === "invoice") {
      const inv = p.d.doc;
      const g = bucket(inv.seller.gstin ?? "", inv.issueDate);
      const docs = g.documents;
      if (!docs.fromNo || inv.number < docs.fromNo) docs.fromNo = inv.number;
      if (!docs.toNo || inv.number > docs.toNo) docs.toNo = inv.number;
      if (inv.status === "cancelled") { docs.cancelled += 1; continue; }
      docs.issued += 1;
      add(inv.buyer.gstin ? g.b2b : g.b2c, inv);
    } else if (p.d.docType === "credit_note") {
      const cn = p.d.doc;
      if (cn.status === "cancelled") continue;
      add(bucket(cn.invoice.seller.gstin ?? "", cn.issueDate).creditNotes, cn);
    } else if (p.d.docType === "receipt") {
      const r = p.d.doc;
      if (r.status !== "recorded" || !r.tdsPaise) continue;
      const fy = financialYear(r.paidOn).label;
      const t = tds.get(fy) ?? { fy, ledger: tdsLedgerName(s.ledgers.tdsReceivable, r.paidOn), paise: 0, receipts: 0 };
      t.paise += r.tdsPaise; t.receipts += 1;
      tds.set(fy, t);
    }
  }
  const tallyShouldShow = {
    gst: [...gstRows.values()].sort((a, b) => (a.gstin + a.month < b.gstin + b.month ? -1 : 1)),
    tds: [...tds.values()].sort((a, b) => (a.fy < b.fy ? -1 : 1)),
  };

  // 10. Counts.
  const cnt = (t: TallyDocType) => ({
    create: runRows.filter((r) => r.docType === t && r.action === "create").length,
    alter: runRows.filter((r) => r.docType === t && r.action === "alter").length,
    cancel: runRows.filter((r) => r.docType === t && r.action === "cancel").length,
  });
  const counts = {
    sales: cnt("invoice"), creditNotes: cnt("credit_note"), receipts: cnt("receipt"), refunds: cnt("refund"),
    vouchers, unchanged: rows.filter((r) => r.action === "unchanged").length, skipped: rows.filter((r) => r.action === "skip").length,
    blocked: rows.filter((r) => r.action === "blocked").length, beforeBooks: input.beforeBooks, earlierChanges,
    pulledIn: rows.filter((r) => r.reason === "needed").length,
    masters: { partiesNew: partyMasters.length, accountLedgers: accountLedgers.length },
  };

  // 11. Fingerprint (I6).
  const usedNames = [...new Set(rows.map((r) => r.clientId))].filter((id) => parties.has(id)).map((id) => `${id}=${parties.get(id)!.name}`).sort();
  const previewHash = sha256([
    input.company, input.tallyCompany, input.scopeGstin ?? "", input.from, input.to, input.mode, input.release, input.settingsUpdatedAt, input.stateVersion,
    rows.map((r) => `${r.docType}:${r.docId}:${r.action}:${r.hash ?? ""}`).sort().join(","),
    usedNames.join(","),
  ].join("|"));

  const ordered = [...runRows, ...rows.filter((r) => !inRun(r.action)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number < b.number ? -1 : 1))];
  return { rows: ordered, runRows, issues: [...issues.values()], parties, partyMasters, accountLedgers, counts, totals, tallyShouldShow, ledgers, previewHash, controlTotalPaise: totals.controlTotalPaise };
}

/** The two files of a run: masters (new parties + optional account ledgers) and vouchers, in file order. */
export function buildFiles(plan: Plan, tallyCompany: string, release: TallyRelease): { masters: string | null; vouchers: string; masterCount: number } {
  const masterMsgs = [
    ...plan.partyMasters.map((p) => renderPartyLedger(p, release)),
    ...plan.accountLedgers.map((a) => renderAccountLedger(a.name, a.kind)),
  ];
  const vouchers = importEnvelope("Vouchers", tallyCompany, plan.runRows.map((r) => renderRow(r, release)));
  return { masters: masterMsgs.length ? importEnvelope("All Masters", tallyCompany, masterMsgs) : null, vouchers, masterCount: masterMsgs.length };
}
