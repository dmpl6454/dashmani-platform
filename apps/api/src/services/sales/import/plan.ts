import { createHash } from "crypto";
import {
  classifyTds, companyScope, computeTotals, documentNumber, financialYear, findRegistration, GST_STATE_CODES, MAX_PAISE, seriesSerial,
  sellerRegistrations, shortFy, taxModeFor, type CompanyKey, type ImportField, type ImportOptions, type SellerProfileInput, type SellerRegistration, type TaxMode,
} from "@dashmani/shared";
import { amountLevels, IMPORT_FIELD_LABELS, type AmountLevelField, type ImportMapping, type Level } from "./fields";
import { buildClientIndex, matchGroup, type ClientIndexRow, type MatchCandidate, type MatchDecision } from "./match";
import {
  detectDateOrder, dmyOf, gstinChecksumOk, gstinShapeOk, invoiceKey, normaliseParty, parseAmount, parseDay, parseQty, parseRateBp,
  parseStateCode, parseSwipeStatus, rs, type DateOrder, type SwipeStatus,
} from "./values";

// Swipe import (spec-import §4.5–4.11, 4.15): the CHECK. From the stored text grid, the mapping and
// the person's decisions, plus a snapshot of live portal state, build one plan row per invoice —
// every GST/arithmetic check, the registration that billed it, the client it belongs to, its
// receipt and its effect on the invoice series — and a hash of everything that decides the outcome.
// Deterministic and pure: the same inputs give the same plan and the same hash.

export const IMPORT_EARLIEST_DAY = "2017-07-01";
export const GST_SLABS_BP = [0, 500, 1200, 1800, 2800];
export const OLD_RECEIVABLE_DAYS = 365;
export const SERIES_GAPS_LISTED = 20;

export type IssueLevel = "error" | "warning" | "info";
export interface ImportIssue { code: string; level: IssueLevel; message: string }
export type ImportOutcome = "ready" | "warning" | "error" | "excluded" | "duplicate" | "imported" | "failed";

export interface PlanLine { description: string; sac: string; quantity: number; unitPricePaise: number; discountPaise: number; amountPaise: number }

/** Everything apply needs to create one invoice (and its receipt). */
export interface PlanInvoice {
  number: string; key: string; rowNos: number[]; issueDate: string; dueDate: string; fy: string;
  docStatus: "issued" | "cancelled"; swipeStatus: string | null;
  client: { groupKey: string; name: string; gstin: string | null; stateCode: string | null; clientId: string | null; decision: "gstin" | "name" | "user" | "new" | "choose" };
  registration: { gstin: string; label: string; claimSeries: boolean };
  placeOfSupplyCode: string | null; taxMode: TaxMode; gstRateBp: number;
  lines: PlanLine[];
  totals: { subtotalPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number; source: "stated" | "derived" | "computed" };
  payment: { cashPaise: number; tdsPaise: number; paidOn: string; number: string; tdsNote: string | null } | null;
  poNumber: string | null; poDate: string | null; notes: string | null; irn: string | null;
  /** Customer details from the file, used when apply creates the client or fills a missing profile. */
  customer: { address: string | null; city: string | null; pincode: string | null; email: string | null; stateCode: string | null };
}

/** What the check report shows for an invoice, whatever its outcome. */
export interface RowView {
  customer: { name: string; gstin: string | null; groupKey: string; clientId: string | null; clientName: string | null; decision: "gstin" | "name" | "user" | "new" | "choose" };
  registration: { gstin: string; label: string; claimSeries: boolean } | null;
  docStatus: "issued" | "cancelled" | null; swipeStatus: string | null;
  taxMode: TaxMode | null; gstRateBp: number | null;
  taxablePaise: number | null; cgstPaise: number | null; sgstPaise: number | null; igstPaise: number | null; roundOffPaise: number | null; totalPaise: number | null;
  paidPaise: number; tdsPaise: number; b2b: boolean;
}

/** sales_import_invoices.plan — the view always, the invoice when it could be derived. */
export interface StoredPlan { view: RowView; invoice: PlanInvoice | null }

export interface PlanRow {
  key: string; number: string; rowNos: number[]; issueDate: string | null; fy: string | null;
  clientGroup: string; sellerGstin: string | null; outcome: ImportOutcome;
  totalPaise: number | null; paidPaise: number; tdsPaise: number; issues: ImportIssue[]; plan: StoredPlan;
}

export interface ExistingInvoice {
  id: string; k: string; companyKey: string; clientId: string; issueDate: string | null; totalPaise: number;
  importId: string | null; source: string; importStatus: string | null; fileName: string | null; importCreatedAt: string | null;
  clientGstin: string | null; clientName: string | null; issuedAt: string | null;
}

export interface ImportSummary {
  generatedAt: string;
  blockers: ImportIssue[];
  notices: ImportIssue[];
  amountLevels: Partial<Record<AmountLevelField, Level>>;
  dateOrder: DateOrder;
  paidIncludesTds: boolean | null;
  outcomes: Record<"ready" | "warning" | "error" | "excluded" | "duplicate", number>;
  issueCounts: Array<{ code: string; level: IssueLevel; invoices: number }>;
  toImport: { invoices: number; cancelled: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; receipts: number; paidPaise: number; tdsPaise: number; outstandingPaise: number };
  byFy: Array<{ fy: string; invoices: number; cancelled: number; b2bTaxablePaise: number; b2cTaxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; paidPaise: number; tdsPaise: number; outstandingPaise: number }>;
  byRegistration: Array<{ gstin: string; label: string; fy: string; invoices: number; taxablePaise: number; taxPaise: number; firstNumber: string | null; lastNumber: string | null; inFormat: number; offFormat: number; sequenceKey: string; nextBefore: string; nextAfter: string; live: boolean; gaps: string[] }>;
  clientGroups: Array<{ groupKey: string; name: string; gstin: string | null; invoices: number; totalPaise: number; decision: MatchDecision; candidates: MatchCandidate[] }>;
  liveSeriesMoves: Array<{ label: string; from: string; to: string }>;
  rowsRead: number;
  firstFy: string | null; lastFy: string | null;
  reconcile?: { ok: boolean; byFy: Array<{ fy: string; invoices: number; taxablePaise: number; taxPaise: number; totalPaise: number; planTotalPaise: number }> };
}

export interface PlanInput {
  grid: string[][];
  /** 1-based row of the headings. */
  headerRow: number;
  mapping: ImportMapping;
  options: ImportOptions;
  clientChoices: Record<string, string>;
}

export interface PlanContext {
  company: CompanyKey;
  companyName: string;
  today: string;
  seller: SellerProfileInput | null;
  /** sellerMissingFields(seller) — non-empty blocks the import. */
  sellerMissing: string[];
  otherCompany: { name: string; gstins: string[]; formats: Array<{ prefix: string; digits: number }> };
  clients: ClientIndexRow[];
  existing: ExistingInvoice[];
  /** sales_sequences: key → next */
  sequences: Record<string, number>;
  /** Every invoice number of this company in the portal (for series gaps). */
  portalNumbers: string[];
  /** Other APPLIED imports of the same file into this company. */
  sameFileApplied: number;
  columnsTruncated: boolean;
  fileName: string;
}

export interface Plan {
  rows: PlanRow[];
  summary: ImportSummary;
  planHash: string;
  rowsTotal: number;
  invoicesFound: number;
  invoicesReady: number;
  clientsMatched: number;
}

const REQUIRED: ImportField[] = ["number", "issueDate", "customerName"];
const INVOICE_DOC_TYPES = new Set(["", "invoice", "tax invoice", "sales invoice", "export invoice", "bill of supply"]);
const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "14–16" / "3, 7, 9–10" — sheet rows for messages and notes. */
export function rowsLabel(rowNos: number[]): string {
  const sorted = [...rowNos].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return parts.join(", ");
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const seqKey = (scope: string | null, fyLabel: string) => (scope ? `invoice@${scope}:${fyLabel}` : `invoice:${fyLabel}`);

/** JSON.stringify with object keys sorted, so the hash never depends on key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** The invoice keys and the 1-based rows of an import (for the duplicate query before the check). */
export function extractKeys(input: PlanInput): string[] {
  const col = input.mapping.number;
  if (col === null || col === undefined) return [];
  const keys = new Set<string>();
  for (const row of input.grid.slice(input.headerRow)) {
    const k = invoiceKey(row[col]);
    if (k.key) keys.add(k.key);
  }
  return [...keys];
}

interface Group { key: string; rows: string[][]; rowNos: number[]; rawNumbers: Set<string> }

export class PlanLimitError extends Error {
  constructor(public code: "TOO_MANY_INVOICES", message: string) { super(message); }
}

export function buildPlan(input: PlanInput, ctx: PlanContext, limits: { maxInvoices: number } = { maxInvoices: 5000 }): Plan {
  const { mapping, options } = input;
  const headers = input.grid[input.headerRow - 1] ?? [];
  const body = input.grid.slice(input.headerRow);
  const blockers: ImportIssue[] = [];
  const notices: ImportIssue[] = [];
  const has = (f: ImportField) => mapping[f] !== null && mapping[f] !== undefined;
  const cell = (row: string[], f: ImportField) => (has(f) ? (row[mapping[f] as number] ?? "").trim() : "");
  const label = (f: ImportField) => (has(f) ? headers[mapping[f] as number] || IMPORT_FIELD_LABELS[f] : IMPORT_FIELD_LABELS[f]);

  if (!ctx.seller || ctx.sellerMissing.length) {
    blockers.push({ code: "SELLER_PROFILE_INCOMPLETE", level: "error", message: `Complete ${ctx.companyName}'s GST profile in Settings before importing invoices` });
  }
  if (ctx.columnsTruncated) notices.push({ code: "COLUMNS_TRUNCATED", level: "info", message: "The sheet has more than 200 columns — only the first 200 were read" });
  if (ctx.sameFileApplied > 0) notices.push({ code: "SAME_FILE_IMPORTED", level: "info", message: "This exact file was imported before — invoices already in the portal are skipped" });

  const missingRequired = REQUIRED.filter((f) => !has(f));
  if (!has("taxable") && !(has("quantity") && has("rate"))) missingRequired.push("taxable");
  const emptySummary = (dateOrder: DateOrder): ImportSummary => ({
    generatedAt: new Date().toISOString(), blockers, notices, amountLevels: {}, dateOrder, paidIncludesTds: null,
    outcomes: { ready: 0, warning: 0, error: 0, excluded: 0, duplicate: 0 }, issueCounts: [],
    toImport: { invoices: 0, cancelled: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0, receipts: 0, paidPaise: 0, tdsPaise: 0, outstandingPaise: 0 },
    byFy: [], byRegistration: [], clientGroups: [], liveSeriesMoves: [], rowsRead: body.length, firstFy: null, lastFy: null,
  });
  if (missingRequired.length) {
    for (const f of missingRequired) blockers.push({ code: "REQUIRED_FIELD_UNMAPPED", level: "error", message: `Map the column for ${IMPORT_FIELD_LABELS[f]}${f === "taxable" ? " (or both Quantity and Rate)" : ""}` });
    const summary = emptySummary("dmy");
    return { rows: [], summary, planHash: hashOf(input, ctx, [], []), rowsTotal: body.length, invoicesFound: 0, invoicesReady: 0, clientsMatched: 0 };
  }

  // ── Dates: one order for every date column ──
  let dateOrder: DateOrder;
  if (options.dateOrder === "dmy" || options.dateOrder === "mdy") dateOrder = options.dateOrder;
  else {
    const d = detectDateOrder(body.map((r) => cell(r, "issueDate")).filter(Boolean));
    dateOrder = d.order;
    if (d.conflict) blockers.push({ code: "DATE_ORDER_CONFLICT", level: "error", message: "Some dates read day-first and others month-first — choose the date order on the Columns step" });
    else if (d.assumed) notices.push({ code: "DATE_ORDER_ASSUMED", level: "info", message: "Dates were read day-first: 05/11/2026 = 5 November 2026" });
  }

  // ── Rows → invoice groups ──
  let notInvoice = 0;
  let drafts = 0;
  let noNumber = 0;
  const groups = new Map<string, Group>();
  body.forEach((row, i) => {
    const rowNo = input.headerRow + i + 1;
    if (row.every((c) => (c ?? "").trim() === "")) return;
    const first = (row.find((c) => (c ?? "").trim() !== "") ?? "").trim().toLowerCase();
    if (first.startsWith("total") || first.startsWith("grand total")) return;
    const num = cell(row, "number");
    if (!num) { noNumber++; return; }
    if (has("docType") && !INVOICE_DOC_TYPES.has(normText(cell(row, "docType")))) { notInvoice++; return; }
    if (parseSwipeStatus(cell(row, "status")).status === "draft") { drafts++; return; }
    const k = invoiceKey(num);
    let g = groups.get(k.key);
    if (!g) { g = { key: k.key, rows: [], rowNos: [], rawNumbers: new Set() }; groups.set(k.key, g); }
    g.rows.push(row);
    g.rowNos.push(rowNo);
    g.rawNumbers.add(k.number);
  });
  if (notInvoice) notices.push({ code: "NOT_AN_INVOICE", level: "info", message: `${notInvoice.toLocaleString("en-IN")} rows are credit notes, estimates or other documents — not imported` });
  if (drafts) notices.push({ code: "DRAFT_SKIPPED", level: "info", message: `${drafts.toLocaleString("en-IN")} rows are Swipe drafts (never issued) — not imported` });
  if (noNumber) notices.push({ code: "ROW_WITHOUT_NUMBER", level: "info", message: `${noNumber.toLocaleString("en-IN")} rows have no invoice number — skipped` });
  if (groups.size > limits.maxInvoices) {
    throw new PlanLimitError("TOO_MANY_INVOICES", `This file has ${groups.size.toLocaleString("en-IN")} invoices — the limit is ${limits.maxInvoices.toLocaleString("en-IN")} per import. Export one financial year at a time.`);
  }
  const groupList = [...groups.values()];

  // ── Amount levels ──
  const lv = amountLevels(groupList.map((g) => g.rows), mapping, options.amountLevel);
  const levels = lv.levels;
  if (lv.oneRowPerInvoice) notices.push({ code: "ONE_ROW_PER_INVOICE", level: "info", message: "One row per invoice — every amount is read as the invoice's figure" });
  else if (Object.keys(levels).length) {
    const per = (l: Level) => (Object.entries(levels) as Array<[AmountLevelField, Level]>).filter(([, v]) => v === l).map(([f]) => IMPORT_FIELD_LABELS[f]);
    const line = per("line");
    const inv = per("invoice");
    notices.push({ code: "AMOUNT_LEVEL", level: "info", message: [line.length ? `${line.join(", ")} read per item, summed per invoice` : "", inv.length ? `${inv.join(", ")} read per invoice` : ""].filter(Boolean).join("; ") });
  }

  // Per-invoice figure of an amount field: Σ rows when line-level, else the rows' agreed value.
  const amountOf = (g: Group, f: ImportField): { value: number | null; error?: string; rounded?: boolean } => {
    if (!has(f)) return { value: null };
    const lineLevel = (levels as Record<string, Level | undefined>)[f] === "line";
    let sum = 0;
    let any = false;
    let first: number | null = null;
    let rounded = false;
    for (const r of g.rows) {
      const a = parseAmount(cell(r, f));
      if ("error" in a) return { value: null, error: `${label(f)}: ${a.error}` };
      if ("blank" in a) continue;
      if (a.rounded) rounded = true;
      any = true;
      if (lineLevel) sum += a.paise;
      else if (first === null) first = a.paise;
    }
    if (!any) return { value: null };
    return { value: lineLevel ? sum : first, rounded };
  };

  // Rows of one invoice must agree on its invoice-level fields (blanks ignored).
  const disagreement = (g: Group, f: ImportField, kind: "text" | "amount" | "day"): string | null => {
    if (!has(f) || g.rows.length < 2) return null;
    const seen: Array<{ norm: string; raw: string; rowNo: number }> = [];
    g.rows.forEach((r, i) => {
      const raw = cell(r, f);
      if (!raw || raw === "-") return;
      let norm = raw.toLowerCase().replace(/\s+/g, " ");
      if (kind === "amount") { const a = parseAmount(raw); norm = "paise" in a ? String(a.paise) : norm; }
      if (kind === "day") norm = parseDay(raw, dateOrder) ?? norm;
      seen.push({ norm, raw, rowNo: g.rowNos[i] });
    });
    const other = seen.find((s) => s.norm !== seen[0]?.norm);
    if (!other) return null;
    return `Rows ${rowsLabel(g.rowNos)} disagree on ${label(f)} (${seen[0].raw} vs ${other.raw}) — two invoices may share a number`;
  };

  // ── Paid vs TDS: one hypothesis for the whole file (§4.8) ──
  let includesTds: boolean | null = null;
  {
    const evidence = { h1: 0, h2: 0 };
    let anyTds = false;
    for (const g of groupList) {
      const T = amountOf(g, "total").value;
      const P = amountOf(g, "amountPaid").value ?? 0;
      const D = amountOf(g, "tds").value ?? 0;
      const B = amountOf(g, "balance").value;
      if (D <= 0) continue;
      anyTds = true;
      if (T === null || !has("amountPaid")) continue;
      if (has("balance") && B !== null) {
        const fit1 = Math.abs(B - (T - P - D)) <= 100;
        const fit2 = Math.abs(B - (T - P)) <= 100;
        if (fit1 && !fit2) evidence.h1++;
        else if (fit2 && !fit1) evidence.h2++;
      } else if (!has("balance") && P + D > T + 100) evidence.h2++;
    }
    if (options.paidIncludesTds === "yes") includesTds = true;
    else if (options.paidIncludesTds === "no") includesTds = false;
    else if (!anyTds) includesTds = null;
    else if (!has("amountPaid")) includesTds = false;
    else if (evidence.h1 && !evidence.h2) {
      includesTds = false;
      notices.push({ code: "PAID_TDS_DETECTED", level: "info", message: `Amount Paid excludes TDS — checked on ${evidence.h1.toLocaleString("en-IN")} invoice${evidence.h1 === 1 ? "" : "s"}` });
    } else if (evidence.h2 && !evidence.h1) {
      includesTds = true;
      notices.push({ code: "PAID_TDS_DETECTED", level: "info", message: `Amount Paid includes TDS — checked on ${evidence.h2.toLocaleString("en-IN")} invoice${evidence.h2 === 1 ? "" : "s"}` });
    } else {
      includesTds = false;
      blockers.push({ code: "PAID_TDS_AMBIGUOUS", level: "error", message: "Swipe's Amount Paid may or may not include TDS — choose on the Columns step" });
    }
  }

  // ── Context: registrations, clients, duplicates ──
  const seller = ctx.seller;
  const regs: SellerRegistration[] = seller ? sellerRegistrations(seller).filter((r) => r.gstin) : [];
  const principal = regs[0] ?? null;
  const ownGstins = new Set([...regs.map((r) => r.gstin!.toUpperCase()), ...ctx.otherCompany.gstins.map((g) => g.toUpperCase())]);
  const otherGstins = new Set(ctx.otherCompany.gstins.map((g) => g.toUpperCase()));
  const regLabel = (r: SellerRegistration) => `${r.label === "Principal" ? r.city || "Principal" : r.label} (${r.gstin})`;
  const clientIndex = buildClientIndex(ctx.clients);
  const existingByKey = new Map<string, ExistingInvoice[]>();
  for (const e of ctx.existing) { const l = existingByKey.get(e.k) ?? []; l.push(e); existingByKey.set(e.k, l); }
  const exclude = new Set(options.exclude.map((k) => k.toUpperCase()));
  const matchCache = new Map<string, ReturnType<typeof matchGroup>>();
  let droppedChoices = 0;
  const matchFor = (groupKey: string, name: string, gstin: string | null) => {
    let m = matchCache.get(groupKey);
    if (!m) {
      m = matchGroup(clientIndex, { groupKey, name, gstin }, input.clientChoices[groupKey]);
      if (m.choiceDropped) droppedChoices++;
      matchCache.set(groupKey, m);
    }
    return m;
  };
  const defaultSac = seller?.defaultSac ?? "998365";

  const rows: PlanRow[] = [];
  for (const g of groupList) {
    const issues: ImportIssue[] = [];
    const add = (code: string, level: IssueLevel, message: string) => issues.push({ code, level, message });
    const number = [...g.rawNumbers][0];
    if (g.rawNumbers.size > 1) add("DUPLICATE_IN_FILE", "error", `${[...g.rawNumbers].join(" and ")} differ only by case or spaces — the same number twice in the file`);
    if (!invoiceKey(number).ok) add("BAD_NUMBER", "error", `${number} is not a valid GST invoice number (16 characters at most: letters, digits, / and -)`);

    // Consensus on invoice-level fields.
    const textFields: ImportField[] = ["customerName", "customerGstin", "placeOfSupply", "sellerGstin", "status", "poNumber", "notes", "irn"];
    const dayFields: ImportField[] = ["issueDate", "dueDate", "poDate", "paidOn"];
    const amountFields: ImportField[] = ["amountPaid", "tds", "balance", "roundOff", "cess", "tcs", ...(["taxable", "discount", "cgst", "sgst", "igst", "totalTax", "total"] as ImportField[]).filter((f) => (levels as Record<string, Level>)[f] !== "line")];
    for (const f of textFields) { const d = disagreement(g, f, "text"); if (d) add("ROWS_DISAGREE", "error", d); }
    for (const f of dayFields) { const d = disagreement(g, f, "day"); if (d) add("ROWS_DISAGREE", "error", d); }
    for (const f of amountFields) { const d = disagreement(g, f, "amount"); if (d) add("ROWS_DISAGREE", "error", d); }
    const firstOf = (f: ImportField) => { for (const r of g.rows) { const v = cell(r, f); if (v && v !== "-") return v; } return ""; };

    // 1 Dates
    const issueRaw = firstOf("issueDate");
    const issueDate = parseDay(issueRaw, dateOrder);
    let fy: ReturnType<typeof financialYear> | null = null;
    if (!issueDate || issueDate < IMPORT_EARLIEST_DAY || issueDate > ctx.today) {
      add("DATE_OUT_OF_RANGE", "error", issueDate ? `${number} is dated ${dmyOf(issueDate)} — invoices must be dated from 01-07-2017 to today` : `${number} has no readable invoice date (${issueRaw || "blank"})`);
    } else fy = financialYear(issueDate);
    let fyMismatch = false;
    if (fy) {
      const m = /\/(\d{2})-(\d{2})\//.exec(`/${number}/`.replace(/\/\//g, "/"));
      if (m && `${m[1]}-${m[2]}` !== fy.short) {
        fyMismatch = true;
        add("FY_MISMATCH", "warning", `${number} is dated ${dmyOf(issueDate!)} (FY ${fy.label}) — its number says ${m[1]}-${m[2]}; the series is not moved`);
      }
    }
    let dueDate: string | null = null;
    if (issueDate) {
      const dueParsed = parseDay(firstOf("dueDate"), dateOrder);
      if (dueParsed) dueDate = dueParsed;
      else { dueDate = addDays(issueDate, seller?.defaultDueDays ?? 15); add("DUE_DEFAULTED", "info", `No due date — set to ${dmyOf(dueDate)} (${seller?.defaultDueDays ?? 15} days)`); }
      if (dueDate < issueDate) { dueDate = issueDate; add("DUE_BEFORE_ISSUE", "warning", "The due date is before the invoice date — set to the invoice date"); }
    }
    const poRaw = firstOf("poDate");
    const poDate = poRaw ? parseDay(poRaw, dateOrder) : null;
    if (poRaw && !poDate) add("PO_DATE_UNREADABLE", "info", `PO date "${poRaw}" could not be read — left empty`);

    // Customer
    const customerName = firstOf("customerName");
    if (!customerName) add("CUSTOMER_MISSING", "error", "No customer name");
    const gstinRaw = firstOf("customerGstin").replace(/\s+/g, "").toUpperCase();
    let customerGstin: string | null = null;
    if (gstinRaw && gstinRaw !== "-" && !/^(NA|N\/A|URP|UNREGISTERED)$/.test(gstinRaw)) {
      if (!gstinShapeOk(gstinRaw)) add("BAD_GSTIN", "error", `${gstinRaw} is not a valid GSTIN — fix it in the file, or clear the cell to import it as an unregistered buyer`);
      else {
        customerGstin = gstinRaw;
        if (!gstinChecksumOk(gstinRaw)) add("GSTIN_CHECKSUM", "warning", `${gstinRaw} fails the GSTIN check digit — check it against the GST portal`);
        if (ownGstins.has(gstinRaw)) add("OWN_GSTIN", "error", `${gstinRaw} is one of our own GSTINs — it cannot be the customer`);
      }
    }
    const normName = normaliseParty(customerName) || customerName.toLowerCase().trim();
    const groupKey = (customerGstin ? `gstin:${customerGstin}` : `name:${normName}`).slice(0, 80);
    const match = matchFor(groupKey, customerName, customerGstin);
    for (const i of match.issues) add(i.code, i.level, i.message);
    const decision = match.decision;
    const clientId = decision.action === "match" ? decision.clientId : null;
    const decisionTag: RowView["customer"]["decision"] = decision.action === "match" ? decision.by : decision.action === "create" ? "new" : "choose";
    if (decision.action === "choose") add("CLIENT_TO_CHOOSE", "info", "More than one portal client matches — pick one on the Clients tab");
    const matchedClient = clientId ? clientIndex.byId.get(clientId) : undefined;

    // Status
    const st = parseSwipeStatus(firstOf("status"));
    if (st.unknown) add("STATUS_UNKNOWN", "warning", `Swipe status "${firstOf("status")}" is not recognised — the amounts decide`);
    const swipeStatus: SwipeStatus | null = st.status;
    const docStatus: "issued" | "cancelled" = swipeStatus === "cancelled" ? "cancelled" : "issued";

    // 2 Place of supply
    const posCol = parseStateCode(firstOf("placeOfSupply"));
    const posState = parseStateCode(firstOf("customerState"));
    const pos: string | null = posCol ?? (customerGstin ? customerGstin.slice(0, 2) : null) ?? posState ?? matchedClient?.billingProfile?.stateCode ?? null;
    if (customerGstin && pos && pos !== "EXPORT" && pos !== customerGstin.slice(0, 2)) add("POS_GSTIN_DIFFER", "warning", `Place of supply ${pos} differs from the customer GSTIN's state ${customerGstin.slice(0, 2)}`);

    // 4 Stated figures
    const figures: Partial<Record<ImportField, number | null>> = {};
    for (const f of ["taxable", "discount", "cgst", "sgst", "igst", "totalTax", "total", "roundOff", "cess", "tcs", "amountPaid", "tds", "balance"] as ImportField[]) {
      const a = amountOf(g, f);
      if (a.error) add("BAD_AMOUNT", "error", a.error);
      if (a.rounded) add("FRACTION_ROUNDED", "info", `${label(f)} had more than 2 decimals — rounded to the paisa`);
      figures[f] = a.value;
    }
    if ((figures.cess ?? 0) !== 0 || (figures.tcs ?? 0) !== 0) add("CESS_OR_TCS", "error", `Cess/TCS of ${rs((figures.cess ?? 0) + (figures.tcs ?? 0))} isn't supported — this invoice can't be imported`);

    // 3 Lines
    const lineLevelTaxable = has("taxable") && (levels as Record<string, Level>).taxable === "line";
    const itemCols = has("quantity") && has("rate");
    let lines: PlanLine[] = [];
    let qtyFraction = false;
    let sacDefaulted = false;
    const rates = new Set<number>();
    const lineFrom = (r: string[], amountPaise: number): PlanLine => {
      const name = cell(r, "itemName");
      const desc = cell(r, "itemDescription");
      let description = (name ? (desc && desc !== name ? `${name} — ${desc}` : name) : desc) || `As per invoice ${number}`;
      const hsn = cell(r, "hsnSac").replace(/\D/g, "");
      const sac = hsn.length >= 4 && hsn.length <= 8 ? hsn : (sacDefaulted = true, defaultSac);
      const q = parseQty(cell(r, "quantity"));
      const rateA = parseAmount(cell(r, "rate"));
      const rate = "paise" in rateA ? rateA.paise : null;
      let quantity = 1;
      let unit = amountPaise;
      let disc = 0;
      if (q !== null && rate !== null && rate > 0) {
        if (!Number.isInteger(q) || q > 10_000) {
          qtyFraction = true;
          description += ` (${q} × ${rs(rate)})`;
        } else if (q * rate >= amountPaise) { quantity = q; unit = rate; disc = q * rate - amountPaise; }
        else if (amountPaise % q === 0) { quantity = q; unit = amountPaise / q; }
        else { qtyFraction = true; description += ` (${q} × ${rs(rate)})`; }
      }
      return { description: description.slice(0, 300), sac, quantity, unitPricePaise: unit, discountPaise: disc, amountPaise: Math.max(0, quantity * unit - disc) };
    };
    const rowAmount = (r: string[]): number | null => {
      if (lineLevelTaxable) { const a = parseAmount(cell(r, "taxable")); if ("paise" in a) return a.paise; }
      if (itemCols) {
        const q = parseQty(cell(r, "quantity"));
        const ra = parseAmount(cell(r, "rate"));
        const ld = parseAmount(cell(r, "lineDiscount"));
        if (q !== null && "paise" in ra) return Math.round(q * ra.paise) - ("paise" in ld ? ld.paise : 0);
      }
      return null;
    };
    // Every row's GST rate (one rate per invoice is supported) — read from all rows, whatever builds the lines.
    for (const r of g.rows) { const gr = parseRateBp(cell(r, "gstRate")); if (gr !== null) rates.add(gr); }
    const perRow = g.rows.map(rowAmount);
    if (perRow.every((a) => a !== null)) {
      if (perRow.some((a) => (a as number) < 0)) add("NEGATIVE_AMOUNT", "error", "A line has a negative amount");
      lines = g.rows.map((r, i) => lineFrom(r, Math.max(0, perRow[i] as number)));
    } else if (figures.taxable !== null && figures.taxable !== undefined) {
      const names = [...new Set(g.rows.map((r) => cell(r, "itemName")).filter(Boolean))];
      const one = lineFrom(g.rows[0], Math.max(0, figures.taxable));
      if (g.rows.length > 1) {
        one.description = (names.length ? names.join("; ") : `As per invoice ${number}`).slice(0, 300);
        one.quantity = 1; one.unitPricePaise = Math.max(0, figures.taxable); one.discountPaise = 0; one.amountPaise = one.unitPricePaise;
        add("LINES_MERGED", "info", "Item amounts are not in the file — the invoice is imported as one line at its taxable value");
      }
      lines = [one];
    } else {
      add("LINES_UNKNOWN", "error", "No taxable value and no quantity × rate to build the invoice lines from");
    }
    if (qtyFraction) add("QTY_FRACTION", "info", "A fractional or very large quantity is imported as 1 unit at the line amount (the quantity is kept in the description)");
    if (sacDefaulted) add("SAC_DEFAULTED", "info", `No HSN/SAC on some lines — ${defaultSac} used`);
    if (lines.length > 200) add("TOO_MANY_LINES", "error", `${lines.length} lines — an invoice holds at most 200`);
    if (has("gstRate") && rates.size > 1) add("MIXED_GST_RATES", "error", `Lines carry ${[...rates].map((r) => `${r / 100}%`).join(" and ")} — one GST rate per invoice is supported; this invoice can't be imported`);

    // Tax, registration, totals
    const TOL = Math.max(100, lines.length);
    const subtotal = lines.reduce((s, l) => s + l.amountPaise, 0);
    let taxable = figures.taxable ?? (lines.length ? subtotal - (figures.discount ?? 0) : null);
    const stCgst = has("cgst") ? figures.cgst ?? 0 : null;
    const stSgst = has("sgst") ? figures.sgst ?? 0 : null;
    const stIgst = has("igst") ? figures.igst ?? 0 : null;
    const taxColsMapped = has("cgst") || has("sgst") || has("igst");
    const totalTaxStated = !taxColsMapped && has("totalTax") && figures.totalTax !== null ? figures.totalTax! : null;
    const totalStated = figures.total ?? null;
    let cgst = 0, sgst = 0, igst = 0, total = 0, roundOff = 0;
    let mode: TaxMode | null = null;
    let rateBp: number | null = null;
    let source: "stated" | "derived" | "computed" = "stated";
    const stated = taxColsMapped && (figures.cgst !== null || figures.sgst !== null || figures.igst !== null);

    // §4.6 registration (E2 only when the taxes themselves say intra)
    const resolveReg = (statedMode: TaxMode | null): { reg: SellerRegistration | null; claimSeries: boolean } => {
      if (!regs.length || !fy) return { reg: null, claimSeries: false };
      const strong: Array<{ name: string; set: SellerRegistration[] }> = [];
      if (options.registration !== "auto") {
        const r = findRegistration(seller!, options.registration);
        if (r) strong.push({ name: `Billed from is set to ${regLabel(r)}`, set: [r] });
      }
      const sg = firstOf("sellerGstin").replace(/\s+/g, "").toUpperCase();
      if (sg) {
        const r = regs.find((x) => x.gstin!.toUpperCase() === sg);
        if (r) strong.push({ name: `the file says ${sg}`, set: [r] });
        else if (otherGstins.has(sg)) { add("OTHER_COMPANY", "error", `${sg} is ${ctx.otherCompany.name}'s GSTIN — upload this file under ${ctx.otherCompany.name}`); return { reg: null, claimSeries: false }; }
        else { add("UNKNOWN_SELLER_GSTIN", "error", `${sg} is not one of ${ctx.companyName}'s GSTINs`); return { reg: null, claimSeries: false }; }
      }
      if (statedMode === "intra" && pos && pos !== "EXPORT") {
        const inState = regs.filter((r) => r.stateCode === pos);
        if (!inState.length) { add("INTRA_WITHOUT_REGISTRATION", "error", `CGST+SGST charged to a client in ${GST_STATE_CODES[pos] ?? pos} (${pos}), where ${ctx.companyName} holds no registration`); return { reg: null, claimSeries: false }; }
        strong.push({ name: `CGST+SGST were charged in ${GST_STATE_CODES[pos] ?? pos} (${pos})`, set: inState });
      }
      const inFormat = regs.filter((r) => seriesSerial(number, r.invoicePrefix, fy!.label, r.serialDigits) !== null);
      if (!inFormat.length && ctx.otherCompany.formats.some((f) => seriesSerial(number, f.prefix, fy!.label, f.digits) !== null)) {
        add("OTHER_COMPANY", "error", `${number} is in ${ctx.otherCompany.name}'s invoice format — upload this file under ${ctx.otherCompany.name}`);
        return { reg: null, claimSeries: false };
      }
      let reg: SellerRegistration;
      if (strong.length) {
        let set = strong[0].set;
        for (const s of strong.slice(1)) set = set.filter((r) => s.set.includes(r));
        if (set.length !== 1) {
          if (!set.length) add("REGISTRATION_CONFLICT", "error", `${strong.map((s) => s.name).join(", but ")} — the registration can't be both`);
          else add("REGISTRATION_CONFLICT", "error", `More than one registration fits (${set.map(regLabel).join(", ")}) — pick Billed from on the Columns step`);
          return { reg: null, claimSeries: false };
        }
        reg = set[0];
        if (inFormat.length && !inFormat.includes(reg)) add("NUMBER_NOT_IN_SERIES", "info", `${number} is not in ${regLabel(reg)}'s number format — its series is not moved`);
      } else if (inFormat.length === 1) {
        reg = inFormat[0];
        if (reg !== principal) add("REGISTRATION_ASSUMED", "warning", `Billed from ${regLabel(reg)}, read from the ${reg.serialDigits}-digit serial — pick Billed from on the Columns step if that is wrong`);
      } else {
        reg = principal!;
        if (regs.length > 1) add("REGISTRATION_ASSUMED", "warning", `Billed from assumed ${regLabel(reg)} (principal) — nothing in the row says which registration issued it`);
      }
      let claimSeries = !fyMismatch && seriesSerial(number, reg.invoicePrefix, fy.label, reg.serialDigits) !== null;
      if (!claimSeries && !fyMismatch) add("OFF_FORMAT_NUMBER", "info", `${number} isn't in the ${reg.invoicePrefix} series format, so the portal can never produce it — nothing to move`);
      if (fyMismatch) claimSeries = false;
      return { reg, claimSeries };
    };

    let regRes: { reg: SellerRegistration | null; claimSeries: boolean } = { reg: null, claimSeries: false };
    const modeForReg = (r: SellerRegistration | null): TaxMode => (pos === "EXPORT" ? "none" : taxModeFor(r?.stateCode ?? null, pos, "IN"));
    const snap = (tax: number, base: number): number | null => {
      if (base <= 0) return tax === 0 ? 0 : null;
      const exact = Math.round((tax * 10_000) / base);
      const s = GST_SLABS_BP.find((b) => Math.abs(b - exact) <= 50);
      return s ?? null;
    };
    const columnRate = has("gstRate") && rates.size === 1 ? [...rates][0] : null;

    if (taxable !== null && lines.length) {
      if (stated) {
        cgst = stCgst ?? 0; sgst = stSgst ?? 0; igst = stIgst ?? 0;
        if ((cgst > 0 || sgst > 0) && igst > 0) add("BOTH_IGST_AND_CGST", "error", "Both IGST and CGST/SGST are charged — one kind only");
        mode = cgst > 0 || sgst > 0 ? "intra" : igst > 0 ? "inter" : "none";
        regRes = resolveReg(mode);
        if (totalStated !== null) total = totalStated;
        else {
          const exact = taxable + cgst + sgst + igst;
          total = seller?.roundToRupee === false ? exact : Math.round(exact / 100) * 100;
          source = "derived";
          add("TOTAL_DERIVED", "info", "No invoice total in the file — worked out from taxable + GST");
        }
      } else if (totalTaxStated !== null || totalStated !== null) {
        regRes = resolveReg(null);
        mode = modeForReg(regRes.reg);
        source = "derived";
        if (totalTaxStated !== null) {
          const tax = totalTaxStated;
          if (mode === "intra") { cgst = Math.floor(tax / 2); sgst = tax - cgst; if (tax % 2) add("TAX_SPLIT", "info", "The total tax is odd — CGST got the smaller half"); }
          else if (mode === "inter") igst = tax;
          else if (tax !== 0) add("TAX_WITHOUT_MODE", "error", "Tax is charged on a supply outside India");
          if (totalStated !== null) total = totalStated;
          else { const exact = taxable + tax; total = seller?.roundToRupee === false ? exact : Math.round(exact / 100) * 100; add("TOTAL_DERIVED", "info", "No invoice total in the file — worked out from taxable + GST"); }
        } else {
          const tax = totalStated! - taxable;
          rateBp = mode === "none" ? 0 : snap(tax, taxable);
          if (rateBp === null) add("TAX_RATE_MISMATCH", "error", `The total implies GST of ${rs(tax)} on ${rs(taxable)} — not a GST rate`);
          else {
            const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: taxable }], taxMode: mode, gstRateBp: rateBp, roundToRupee: true });
            cgst = t.cgstPaise; sgst = t.sgstPaise; igst = t.igstPaise; total = totalStated!;
            if (Math.abs(t.totalPaise - totalStated!) > TOL) add("TOTAL_DOESNT_ADD_UP", "error", `${rs(totalStated!)} is not ${rs(taxable)} + ${rateBp / 100}% GST (${rs(t.totalPaise)})`);
            else add("TAX_DERIVED", "info", `No tax columns — GST worked out from the total at ${rateBp / 100}%`);
          }
        }
      } else {
        regRes = resolveReg(null);
        mode = modeForReg(regRes.reg);
        rateBp = mode === "none" ? 0 : columnRate ?? seller?.defaultGstRateBp ?? 1800;
        const t = computeTotals({ lines, discountPaise: figures.discount ?? 0, taxMode: mode, gstRateBp: rateBp, roundToRupee: seller?.roundToRupee ?? true });
        taxable = t.taxablePaise; cgst = t.cgstPaise; sgst = t.sgstPaise; igst = t.igstPaise; total = t.totalPaise; roundOff = t.roundOffPaise;
        source = "computed";
        add("COMPUTED_TOTALS", "warning", `The file has no tax or total — GST computed at ${rateBp / 100}%; check it against Swipe's copy`);
      }

      // 6 Rate
      const tax = cgst + sgst + igst;
      if (rateBp === null) {
        if (mode === "none") rateBp = 0;
        else if (columnRate !== null) rateBp = columnRate;
        else { rateBp = snap(tax, taxable); if (rateBp === null) add("TAX_RATE_MISMATCH", "error", `GST of ${rs(tax)} on ${rs(taxable)} is not a GST rate`); }
      }

      // 7 Arithmetic (stated / derived)
      if (source !== "computed") {
        let discount = subtotal - taxable;
        if (discount >= 0) {
          if (has("discount") && figures.discount !== null && Math.abs((figures.discount ?? 0) - discount) > TOL) add("DISCOUNT_MISMATCH", "error", `Discount ${rs(figures.discount ?? 0)} does not match lines ${rs(subtotal)} − taxable ${rs(taxable)}`);
        } else if (-discount <= TOL) {
          const last = lines[lines.length - 1];
          const amt = last.amountPaise - discount;
          last.quantity = 1; last.unitPricePaise = amt; last.discountPaise = 0; last.amountPaise = amt;
          add("LINE_ADJUSTED", "info", `The lines were ${rs(-discount)} short of the taxable value — the last line absorbs it`);
          discount = 0;
        } else add("LINES_DONT_ADD_UP", "error", `The lines add up to ${rs(subtotal)}, below the taxable value ${rs(taxable)}`);
        if (mode === "intra" && Math.abs(cgst - sgst) > 1) add("CGST_SGST_UNEQUAL", "error", `CGST ${rs(cgst)} and SGST ${rs(sgst)} must be equal`);
        if (rateBp !== null && mode !== "none") {
          const expected = mode === "intra" ? Math.round((taxable * rateBp) / 20_000) : Math.round((taxable * rateBp) / 10_000);
          const actual = mode === "intra" ? cgst : igst;
          if (actual !== expected) {
            if (Math.abs(actual - expected) <= TOL) add("TAX_ROUNDED_PER_LINE", "info", `${mode === "intra" ? "CGST" : "IGST"} ${rs(actual)} vs ${rs(expected)} at ${rateBp / 100}% — rounded per line in Swipe, kept as filed`);
            else add("TAX_DOESNT_MATCH_RATE", "error", `${mode === "intra" ? "CGST" : "IGST"} ${rs(actual)} is not ${rateBp / 100}% of ${rs(taxable)} (${rs(expected)})`);
          }
        }
        if (mode === "none" && tax !== 0) add("TAX_RATE_MISMATCH", "error", "Tax charged on a supply outside India");
        roundOff = total - (taxable + cgst + sgst + igst);
        if (Math.abs(roundOff) > TOL) add("TOTAL_DOESNT_ADD_UP", "error", `${rs(total)} is ${rs(Math.abs(roundOff))} ${roundOff > 0 ? "more" : "less"} than taxable + GST — a TCS, cess or freight column may be unmapped`);
        if (has("roundOff") && figures.roundOff !== null && Math.abs((figures.roundOff ?? 0) - roundOff) > 1) add("ROUND_OFF_MISMATCH", "error", `Round off ${rs(figures.roundOff ?? 0)} does not match ${rs(roundOff)}`);
        if (discount >= 0) figures.discount = discount;
      }
      if (taxable <= 0 || total <= 0 || cgst < 0 || sgst < 0 || igst < 0) add("NEGATIVE_AMOUNT", "error", "Taxable value and total must be above zero and no tax negative");
    }
    if (mode === "inter" && regRes.reg && pos === regRes.reg.stateCode) add("IGST_SAME_STATE", "warning", "IGST charged in the registration's own state — fine for an SEZ unit; otherwise check");
    if (!regRes.reg && !issues.some((i) => i.level === "error") && fy) add("NO_REGISTRATION", "error", `No GST registration of ${ctx.companyName} could bill this invoice`);
    if (pos === null && mode === "intra") add("POS_UNKNOWN", "error", "No place of supply, but CGST+SGST are charged");
    else if (pos === null) add("POS_UNKNOWN", "warning", "No place of supply in the file or on the client");

    const discountStored = source === "computed" ? figures.discount ?? 0 : Math.max(0, subtotal - (taxable ?? 0));
    const subtotalStored = source === "computed" ? lines.reduce((s, l) => s + l.amountPaise, 0) : (taxable ?? 0) + discountStored;
    const lineSum = lines.reduce((s, l) => s + l.amountPaise, 0);
    const fitFigures = { subtotalPaise: subtotalStored, taxablePaise: taxable ?? 0, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalPaise: total, roundOffPaise: roundOff };
    let tooLarge = false;
    for (const [k, v] of Object.entries(fitFigures)) if (Math.abs(v) > MAX_PAISE) { tooLarge = true; add("AMOUNT_TOO_LARGE", "error", `${k.replace(/Paise$/, "")} is above ₹2,14,74,836.47 — too large for one document`); break; }
    void lineSum;

    // §4.8 Settlement
    const T = total;
    const D = figures.tds ?? 0;
    const B = has("balance") ? figures.balance ?? null : null;
    let P: number;
    if (has("amountPaid")) P = figures.amountPaid ?? 0;
    else if (B !== null) P = T - B - D;
    else if (swipeStatus === "paid") P = T - D;
    else P = 0;
    const h2 = has("amountPaid") && includesTds === true;
    let cash = h2 ? P - D : P;
    let tdsAmt = D;
    const settled = h2 ? P : P + D;
    const expectedBalance = h2 ? T - P : T - P - D;
    let paidOn: string | null = null;
    if (cash < 0) add("NEGATIVE_AMOUNT", "error", "The cash received works out below zero");
    if (settled > T + 100) add("OVER_SETTLED", "error", `${rs(settled)} settled on a ${rs(T)} invoice — the import never creates advances; record the extra in the portal`);
    else if (settled > T && T > 0) {
      const excess = settled - T;
      if (cash >= excess) cash -= excess; else { tdsAmt -= excess - cash; cash = 0; }
      add("SETTLEMENT_CAPPED", "info", `${rs(excess)} over the total — the receipt is capped at the invoice total`);
    }
    if (B !== null && T > 0 && Math.abs(B - expectedBalance) > 100) add("BALANCE_MISMATCH", "warning", `Swipe's balance ${rs(B)} does not match ${rs(expectedBalance)} worked out from the amounts`);
    const settledNow = cash + tdsAmt;
    if (swipeStatus === "paid" && settledNow < T && docStatus !== "cancelled") add("STATUS_CONFLICT", "warning", `Swipe says Paid but ${rs(T - settledNow)} is unsettled — imported as part-paid; if the client deducted TDS, add a TDS column and upload again`);
    if (swipeStatus === "unpaid" && cash > 0) add("STATUS_CONFLICT", "warning", `Swipe says unpaid but ${rs(cash)} was received — the amounts win`);
    if (docStatus === "cancelled" && (P > 0 || D > 0)) add("PAID_ON_CANCELLED", "error", "A cancelled invoice shows money received — it can't be imported");
    let payment: PlanInvoice["payment"] = null;
    if (docStatus !== "cancelled" && (cash > 0 || tdsAmt > 0) && issueDate) {
      const paidRaw = firstOf("paidOn");
      paidOn = paidRaw ? parseDay(paidRaw, dateOrder) : null;
      if (!paidOn) { paidOn = issueDate; add("PAID_ON_DEFAULTED", "info", "No payment date — the invoice date is used for the receipt"); }
      if (paidOn > ctx.today) add("PAID_IN_FUTURE", "error", `Paid on ${dmyOf(paidOn)} is in the future`);
      else if (paidOn < issueDate) add("PAID_BEFORE_ISSUE", "warning", `Paid on ${dmyOf(paidOn)}, before the invoice date — kept as filed`);
      let tdsNote: string | null = null;
      if (tdsAmt > 0 && taxable) {
        const c = classifyTds(tdsAmt, taxable, T, customerGstin ? customerGstin.slice(2, 12) : null);
        if (c.kind === "p1" || c.kind === "p2" || c.kind === "p10") { tdsNote = `TDS ${rs(tdsAmt)} = ${c.label}`; add("TDS_SECTION_GUESS", "info", `TDS ${rs(tdsAmt)} = ${c.label} of taxable`); }
        else if (c.kind === "on_total") { tdsNote = `TDS ${rs(tdsAmt)}: ${c.label}`; add("TDS_ON_GROSS", "info", `TDS is ${c.label} — the client deducted on the gross; reconcile with 26AS`); }
        else { tdsNote = `TDS ${rs(tdsAmt)}: ${c.label}`; add("TDS_RATE_UNUSUAL", "info", `TDS is ${c.label} — check the section`); }
      }
      payment = { cashPaise: Math.max(0, cash), tdsPaise: Math.max(0, tdsAmt), paidOn, number: `SW-${number}`, tdsNote };
    }
    if (docStatus !== "cancelled" && issueDate && T > 0 && settledNow < T && issueDate < addDays(ctx.today, -OLD_RECEIVABLE_DAYS)) {
      add("OLD_RECEIVABLE", "warning", `${rs(T - settledNow)} still open on an invoice from ${dmyOf(issueDate)} — confirm it is really unpaid before importing it as a receivable`);
    }

    // §4.9.10 Duplicates
    let duplicate = false;
    const hits = existingByKey.get(g.key) ?? [];
    for (const e of hits) {
      if (e.importId && e.companyKey === ctx.company) {
        duplicate = true;
        add("ALREADY_IMPORTED", "info", `Imported${e.importCreatedAt ? ` on ${dmyOf(e.importCreatedAt.slice(0, 10))}` : ""}${e.fileName ? ` from ${e.fileName}` : ""}`);
      } else if (e.source === "portal" && e.companyKey === ctx.company && e.issueDate === issueDate && e.totalPaise === T && ((clientId && e.clientId === clientId) || (customerGstin && e.clientGstin?.toUpperCase() === customerGstin))) {
        duplicate = true;
        add("IN_PORTAL", "info", `Already in the portal${e.issuedAt ? ` (issued here on ${dmyOf(e.issuedAt.slice(0, 10))})` : ""}`);
      } else {
        add("NUMBER_IN_PORTAL", "error", `${number} is already used in the portal${e.clientName ? ` by ${e.clientName}` : ""} for ${rs(e.totalPaise)}${e.issueDate ? ` on ${dmyOf(e.issueDate)}` : ""} — the same number twice breaks the GST series; check which is right`);
      }
    }

    // §4.9.11 Outcome
    const errors = issues.filter((i) => i.level === "error");
    let outcome: ImportOutcome;
    if (exclude.has(g.key)) outcome = "excluded";
    else if (errors.length) outcome = "error";
    else if (duplicate) outcome = "duplicate";
    else if (issues.some((i) => i.level === "warning")) outcome = "warning";
    else outcome = "ready";

    const reg = regRes.reg;
    const view: RowView = {
      customer: { name: customerName, gstin: customerGstin, groupKey, clientId, clientName: decision.action === "match" ? decision.clientName : null, decision: decisionTag },
      registration: reg ? { gstin: reg.gstin!, label: regLabel(reg), claimSeries: regRes.claimSeries } : null,
      docStatus, swipeStatus: firstOf("status") || null, taxMode: mode, gstRateBp: rateBp,
      taxablePaise: tooLarge ? null : taxable, cgstPaise: mode ? cgst : null, sgstPaise: mode ? sgst : null, igstPaise: mode ? igst : null,
      roundOffPaise: mode ? roundOff : null, totalPaise: tooLarge || !mode ? null : total,
      paidPaise: payment?.cashPaise ?? 0, tdsPaise: payment?.tdsPaise ?? 0, b2b: !!customerGstin,
    };
    let invoice: PlanInvoice | null = null;
    if (!errors.length && reg && issueDate && dueDate && fy && mode && rateBp !== null && taxable !== null && lines.length) {
      invoice = {
        number, key: g.key, rowNos: g.rowNos, issueDate, dueDate, fy: fy.label, docStatus, swipeStatus: view.swipeStatus,
        client: { groupKey, name: customerName, gstin: customerGstin, stateCode: customerGstin ? customerGstin.slice(0, 2) : (posState ?? (pos !== "EXPORT" ? pos : null)), clientId, decision: decisionTag },
        registration: view.registration!, placeOfSupplyCode: pos, taxMode: mode, gstRateBp: rateBp, lines,
        totals: { subtotalPaise: subtotalStored, discountPaise: discountStored, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, roundOffPaise: roundOff, totalPaise: total, source },
        payment, poNumber: firstOf("poNumber") || null, poDate, notes: firstOf("notes") || null, irn: firstOf("irn") || null,
        customer: { address: firstOf("customerAddress") || null, city: firstOf("customerCity") || null, pincode: firstOf("customerPincode") || null, email: firstOf("customerEmail") || null, stateCode: posState ?? (customerGstin ? customerGstin.slice(0, 2) : pos && pos !== "EXPORT" ? pos : null) },
      };
    }
    rows.push({
      key: g.key, number, rowNos: g.rowNos, issueDate, fy: fy?.label ?? null, clientGroup: groupKey, sellerGstin: reg?.gstin ?? null, outcome,
      totalPaise: view.totalPaise, paidPaise: view.paidPaise, tdsPaise: view.tdsPaise, issues, plan: { view, invoice },
    });
  }
  if (droppedChoices) notices.push({ code: "CLIENT_CHOICE_DROPPED", level: "info", message: `${droppedChoices} saved client choice${droppedChoices === 1 ? "" : "s"} pointed at a client that no longer exists — decided again` });

  rows.sort((a, b) => (a.issueDate ?? "9999") .localeCompare(b.issueDate ?? "9999") || a.number.localeCompare(b.number));
  const summary = summarise(rows, ctx, { blockers, notices, levels, dateOrder, includesTds, rowsRead: body.length });
  const planHash = hashOf(input, ctx, rows, summary.liveSeriesMoves);
  const importable = rows.filter((r) => r.outcome === "ready" || r.outcome === "warning");
  const matchedGroups = new Set(importable.filter((r) => r.plan.view.customer.clientId).map((r) => r.clientGroup));
  return { rows, summary, planHash, rowsTotal: body.length, invoicesFound: rows.length, invoicesReady: importable.length, clientsMatched: matchedGroups.size };
}

function summarise(
  rows: PlanRow[],
  ctx: PlanContext,
  s: { blockers: ImportIssue[]; notices: ImportIssue[]; levels: Partial<Record<AmountLevelField, Level>>; dateOrder: DateOrder; includesTds: boolean | null; rowsRead: number },
): ImportSummary {
  const outcomes = { ready: 0, warning: 0, error: 0, excluded: 0, duplicate: 0 };
  const issueTally = new Map<string, { code: string; level: IssueLevel; invoices: number }>();
  for (const r of rows) {
    if (r.outcome in outcomes) outcomes[r.outcome as keyof typeof outcomes]++;
    for (const code of new Set(r.issues.map((i) => `${i.level}|${i.code}`))) {
      const [level, c] = code.split("|") as [IssueLevel, string];
      const t = issueTally.get(code) ?? { code: c, level, invoices: 0 };
      t.invoices++;
      issueTally.set(code, t);
    }
  }
  const rank = { error: 0, warning: 1, info: 2 };
  const issueCounts = [...issueTally.values()].sort((a, b) => rank[a.level] - rank[b.level] || b.invoices - a.invoices || a.code.localeCompare(b.code));

  const importable = rows.filter((r) => (r.outcome === "ready" || r.outcome === "warning") && r.plan.invoice);
  const toImport = { invoices: importable.length, cancelled: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0, receipts: 0, paidPaise: 0, tdsPaise: 0, outstandingPaise: 0 };
  const byFy = new Map<string, ImportSummary["byFy"][number]>();
  for (const r of importable) {
    const inv = r.plan.invoice!;
    const f = byFy.get(inv.fy) ?? { fy: inv.fy, invoices: 0, cancelled: 0, b2bTaxablePaise: 0, b2cTaxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0, paidPaise: 0, tdsPaise: 0, outstandingPaise: 0 };
    f.invoices++;
    if (inv.docStatus === "cancelled") { f.cancelled++; toImport.cancelled++; byFy.set(inv.fy, f); continue; }
    const t = inv.totals;
    if (inv.client.gstin) f.b2bTaxablePaise += t.taxablePaise; else f.b2cTaxablePaise += t.taxablePaise;
    f.cgstPaise += t.cgstPaise; f.sgstPaise += t.sgstPaise; f.igstPaise += t.igstPaise; f.totalPaise += t.totalPaise;
    const paid = inv.payment?.cashPaise ?? 0;
    const tds = inv.payment?.tdsPaise ?? 0;
    f.paidPaise += paid; f.tdsPaise += tds; f.outstandingPaise += Math.max(0, t.totalPaise - paid - tds);
    toImport.taxablePaise += t.taxablePaise; toImport.cgstPaise += t.cgstPaise; toImport.sgstPaise += t.sgstPaise; toImport.igstPaise += t.igstPaise;
    toImport.totalPaise += t.totalPaise; toImport.paidPaise += paid; toImport.tdsPaise += tds; toImport.outstandingPaise += Math.max(0, t.totalPaise - paid - tds);
    if (inv.payment) toImport.receipts++;
    byFy.set(inv.fy, f);
  }

  // §4.11 Series effects
  const seller = ctx.seller;
  const regs = seller ? sellerRegistrations(seller).filter((r) => r.gstin) : [];
  const liveFy = financialYear(ctx.today).label;
  const byReg = new Map<string, ImportSummary["byRegistration"][number] & { serials: number[] }>();
  const liveSeriesMoves: ImportSummary["liveSeriesMoves"] = [];
  for (const r of importable) {
    const inv = r.plan.invoice!;
    const reg = regs.find((x) => x.gstin === inv.registration.gstin);
    if (!reg) continue;
    const key = `${reg.gstin}|${inv.fy}`;
    let e = byReg.get(key);
    if (!e) {
      const sk = seqKey(companyScope(ctx.company, reg.scope), inv.fy);
      const before = ctx.sequences[sk] ?? 1;
      e = { gstin: reg.gstin!, label: inv.registration.label, fy: inv.fy, invoices: 0, taxablePaise: 0, taxPaise: 0, firstNumber: null, lastNumber: null, inFormat: 0, offFormat: 0, sequenceKey: sk, nextBefore: documentNumber(reg.invoicePrefix, inv.fy, before, reg.serialDigits), nextAfter: "", live: inv.fy === liveFy, gaps: [], serials: [] };
      byReg.set(key, e);
    }
    e.invoices++;
    if (inv.docStatus !== "cancelled") { e.taxablePaise += inv.totals.taxablePaise; e.taxPaise += inv.totals.cgstPaise + inv.totals.sgstPaise + inv.totals.igstPaise; }
    const serial = inv.registration.claimSeries ? seriesSerial(inv.number, reg.invoicePrefix, inv.fy, reg.serialDigits) : null;
    if (serial !== null) { e.inFormat++; e.serials.push(serial); } else e.offFormat++;
  }
  for (const e of byReg.values()) {
    const reg = regs.find((x) => x.gstin === e.gstin)!;
    const before = ctx.sequences[e.sequenceKey] ?? 1;
    const max = e.serials.length ? Math.max(...e.serials) : 0;
    const after = Math.max(before, max + 1);
    e.nextAfter = documentNumber(reg.invoicePrefix, e.fy, after, reg.serialDigits);
    const sorted = [...e.serials].sort((a, b) => a - b);
    e.firstNumber = sorted.length ? documentNumber(reg.invoicePrefix, e.fy, sorted[0], reg.serialDigits) : null;
    e.lastNumber = sorted.length ? documentNumber(reg.invoicePrefix, e.fy, sorted[sorted.length - 1], reg.serialDigits) : null;
    if (e.live && after > before) liveSeriesMoves.push({ label: `${reg.invoicePrefix}/${shortFy(e.fy)} (${e.label})`, from: e.nextBefore, to: e.nextAfter });
    // Gaps: serials between the smallest and largest in-format serial (file ∪ portal) present in neither.
    const portal = ctx.portalNumbers.map((n) => seriesSerial(n, reg.invoicePrefix, e.fy, reg.serialDigits)).filter((x): x is number => x !== null);
    const all = new Set([...e.serials, ...portal]);
    if (all.size) {
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      for (let n = lo; n <= hi && e.gaps.length < SERIES_GAPS_LISTED && hi - lo < 100_000; n++) if (!all.has(n)) e.gaps.push(String(n).padStart(reg.serialDigits, "0"));
    }
    if (e.gaps.length) s.notices.push({ code: "SERIES_GAP", level: "warning", message: `${reg.invoicePrefix}/${shortFy(e.fy)}: ${e.gaps.join(", ")} missing — fine only if Swipe has no such invoices (GSTR-1 counts every serial)` });
  }

  // Client groups
  const groups = new Map<string, ImportSummary["clientGroups"][number]>();
  const unresolved = new Set<string>();
  for (const r of rows) {
    if (r.outcome === "excluded" || r.outcome === "duplicate") continue;
    const v = r.plan.view.customer;
    let g = groups.get(v.groupKey);
    if (!g) {
      const decision: MatchDecision = v.decision === "choose" ? { action: "choose" } : v.decision === "new" ? { action: "create", by: "auto" } : { action: "match", clientId: v.clientId!, clientName: v.clientName ?? "", by: v.decision };
      g = { groupKey: v.groupKey, name: v.name, gstin: v.gstin, invoices: 0, totalPaise: 0, decision, candidates: [] };
      groups.set(v.groupKey, g);
    }
    g.invoices++;
    g.totalPaise += r.totalPaise ?? 0;
    if (v.decision === "choose") unresolved.add(v.groupKey);
  }
  // Candidates and the user/auto distinction come from the matcher (cheap: cached per group).
  const index = buildClientIndex(ctx.clients);
  for (const g of groups.values()) {
    const m = matchGroup(index, { groupKey: g.groupKey, name: g.name, gstin: g.gstin }, undefined);
    g.candidates = m.candidates;
    if (g.decision.action === "create" && m.decision.action !== "create") g.decision = { action: "create", by: "user" };
  }
  if (unresolved.size) s.blockers.push({ code: "CLIENTS_UNRESOLVED", level: "error", message: `${unresolved.size} customer${unresolved.size === 1 ? " matches" : "s match"} more than one client — pick the client on the Clients tab` });

  const fys = [...byFy.keys()].sort();
  return {
    generatedAt: new Date().toISOString(), blockers: s.blockers, notices: s.notices, amountLevels: s.levels, dateOrder: s.dateOrder, paidIncludesTds: s.includesTds,
    outcomes, issueCounts, toImport, byFy: [...byFy.values()].sort((a, b) => a.fy.localeCompare(b.fy)),
    byRegistration: [...byReg.values()].map(({ serials: _s, ...e }) => e).sort((a, b) => a.fy.localeCompare(b.fy) || a.gstin.localeCompare(b.gstin)),
    clientGroups: [...groups.values()].sort((a, b) => (a.decision.action === "choose" ? 0 : 1) - (b.decision.action === "choose" ? 0 : 1) || b.invoices - a.invoices || a.name.localeCompare(b.name)),
    liveSeriesMoves, rowsRead: s.rowsRead, firstFy: fys[0] ?? null, lastFy: fys[fys.length - 1] ?? null,
  };
}

/** §4.15: the hash of everything that decides what Import would do. */
function hashOf(input: PlanInput, ctx: PlanContext, rows: PlanRow[], live: ImportSummary["liveSeriesMoves"]): string {
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return createHash("sha256").update(stable({
    company: ctx.company, mapping: input.mapping, headerRow: input.headerRow, options: input.options, clientChoices: input.clientChoices,
    rows: sorted.map((r) => [r.key, r.outcome, r.plan.view.customer.clientId ?? r.plan.view.customer.groupKey, r.plan.view.registration?.gstin ?? null, r.plan.view.registration?.claimSeries ?? null,
      r.plan.view.docStatus, r.plan.invoice?.totals ?? null, r.plan.invoice?.payment ?? null, r.plan.invoice?.lines.length ?? 0]),
    live,
  })).digest("hex");
}
