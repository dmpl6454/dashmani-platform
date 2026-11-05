import { prisma, Prisma } from "@dashmani/db";
import {
  fyBounds,
  gstr1Date,
  gstr1Pos,
  periodBounds,
  SALES_COMPANIES,
  sellerRegistrations,
  todayIST,
  type CompanyKey,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { csvDocument, csvMoney } from "./csv";
import { getSellerOrDefaults } from "./settings.service";
import { FILED_SELECT, filedView } from "./filed.service";
import { assemble, tdsClients, type AccountsView, type ClientName } from "./accounts-assemble";
import {
  CSV_ROW_CAP, Q1, Q2, Q2B, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11,
  creditNoteCsvRows, invoiceCsvRows,
  type Bounds, type CreditNoteCsvRow, type InvoiceCsvRow,
  type Q1Row, type Q2bRow, type Q2Row, type Q3Row, type Q4Row, type Q5Row, type Q6Row, type Q7Row, type Q8Row, type Q9Row, type Q10Row, type Q11Row,
} from "./accounts-sql";

// The accounts page (spec-accounts §3.7, §4.8): live figures from SQL aggregates in ONE read-only
// REPEATABLE READ snapshot (every card agrees), and the GSTR-1 / sales-register / TDS CSVs.
// Never writes a sales_* table; never calls lockInvoices / recomputeSettlement / nextDocumentNumber.

export type { AccountsView } from "./accounts-assemble";

const SLOW_MS = 300;
const NAME_SELECT = { id: true, companyName: true, billingProfile: { select: { legalName: true, gstin: true, pan: true } } } as const;

export async function getAccounts(company: CompanyKey, fy: string): Promise<AccountsView> {
  const t0 = Date.now();
  const fb = fyBounds(fy)!;
  const b: Bounds = { from: fb.startDay, to: fb.endExclusive };
  const today = todayIST();
  const seller = await getSellerOrDefaults(company); // outside the snapshot: settings, not money
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    // Sequential on purpose: one pooled connection, one snapshot.
    const q1 = await tx.$queryRaw<Q1Row[]>(Q1(company, b));
    const q2 = await tx.$queryRaw<Q2Row[]>(Q2(company, b));
    const q2b = await tx.$queryRaw<Q2bRow[]>(Q2B(company, b));
    const q3 = await tx.$queryRaw<Q3Row[]>(Q3(company, b));
    const q4 = await tx.$queryRaw<Q4Row[]>(Q4(company, b));
    const q5 = await tx.$queryRaw<Q5Row[]>(Q5(company, b));
    const q6 = await tx.$queryRaw<Q6Row[]>(Q6(company, b));
    const q7 = await tx.$queryRaw<Q7Row[]>(Q7(company, b, today));
    const q8 = await tx.$queryRaw<Q8Row[]>(Q8(company));
    const q9 = await tx.$queryRaw<Q9Row[]>(Q9(company, b));
    const q10 = await tx.$queryRaw<Q10Row[]>(Q10(company));
    const q11 = await tx.$queryRaw<Q11Row[]>(Q11(company, b));
    const filed = await tx.financeFiledYear.findMany({ where: { companyKey: company }, select: FILED_SELECT, orderBy: { financialYear: "desc" } });
    const clientIds = [...new Set([...q5, ...q6, ...q7, ...q8].map((r) => r.client_id))];
    const names: ClientName[] = clientIds.length ? await tx.client.findMany({ where: { id: { in: clientIds } }, select: NAME_SELECT }) : [];
    return assemble({ company, fy, today, computedAt: new Date().toISOString(), seller, q1, q2, q2b, q3, q4, q5, q6, q7, q8, q9, q10, q11, filed: filed.map(filedView), names });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 15_000 });
  out.bank = await bankSummaryOrNull(company);
  const ms = Date.now() - t0;
  if (ms > SLOW_MS) console.warn(`[sales] accounts ${company} ${fy} took ${ms} ms`);
  return out;
}

/**
 * The bank tile. Returns null in this PR (spec-00 §6.4): the bank feature (PR 4) replaces this
 * body with the company's unmatched credit lines. The portal hides the tile while it is null.
 */
export async function bankSummaryOrNull(_company: CompanyKey): Promise<AccountsView["bank"]> {
  return null;
}

// ─── CSVs ────────────────────────────────────────────────────────────────────────────────────

/** Transcribed from the GST offline tool's b2b sheet, then the three tax columns the owner asked for. */
export const GSTR1_B2B_HEADERS = [
  "GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge",
  "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount", "Integrated Tax", "Central Tax", "State/UT Tax",
] as const;
export const GSTR1_CDNR_HEADERS = [
  "GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type",
  "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "Integrated Tax", "Central Tax", "State/UT Tax",
] as const;
export const REGISTER_HEADERS = [
  "Seller GSTIN", "Section", "Document", "Number", "Date", "Status", "Recipient GSTIN", "Recipient name", "Place of supply", "Tax mode", "Rate %",
  "Taxable value", "CGST", "SGST", "IGST", "Round off", "Document value", "Against invoice", "Cancelled on",
] as const;
export const TDS_HEADERS = [
  "Client", "Legal name", "PAN", "PAN source", "GSTIN", "Q1 Apr-Jun", "Q2 Jul-Sep", "Q3 Oct-Dec", "Q4 Jan-Mar", "Total TDS", "Receipts with TDS", "Rates seen",
] as const;

export const GST_LAYOUTS = ["b2b", "cdnr", "register"] as const;
export type GstLayout = (typeof GST_LAYOUTS)[number];

const SEZ_TYPE = "SEZ supplies without payment";
const supplyType = (section: string) => (section === "sez" ? SEZ_TYPE : "Regular B2B");
/** 1800 → "18", 1250 → "12.5". */
const ratePct = (bp: number) => String(bp / 100);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const pos = (r: { place_of_supply_code: string | null; buyer_state: string | null; buyer_country: string | null }) => gstr1Pos(r.place_of_supply_code ?? r.buyer_state, r.buyer_country);

const tooMany = () => new AppError(422, "TOO_MANY_ROWS", "That period has more than 20,000 documents — download one quarter at a time.");

/** The registration a GSTR-1 file is for: the one asked for (must be a current registration), else the only one. */
function pickRegistration(company: CompanyKey, seller: Parameters<typeof sellerRegistrations>[0], gstin: string | null, required: boolean): string | null {
  const regs = sellerRegistrations(seller).filter((r) => !!r.gstin);
  const short = SALES_COMPANIES[company].short;
  if (gstin) {
    const g = gstin.trim().toUpperCase();
    if (!regs.some((r) => r.gstin!.toUpperCase() === g)) throw new AppError(400, "UNKNOWN_REGISTRATION", `${g} is not one of ${short}'s GST registrations.`);
    return g;
  }
  if (!required) return null;
  if (regs.length === 1) return regs[0].gstin!;
  if (regs.length === 0) throw new AppError(400, "PICK_REGISTRATION", `${short} has no GST registration in Settings — add its GSTIN first.`);
  const names = regs.map((r) => `${r.city ?? r.label} (${r.gstin})`);
  throw new AppError(400, "PICK_REGISTRATION", `${short} files GST from ${regs.length} registrations — pick ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}.`);
}

export async function buildGstCsv(company: CompanyKey, period: string, layout: GstLayout, gstinIn: string | null): Promise<{ filename: string; body: Buffer }> {
  const p = periodBounds(period);
  if (!p) throw new AppError(400, "BAD_PERIOD", "Pick a month (2026-10), a quarter (2026-27-Q3) or a year (2026-27).");
  if (p.from > todayIST()) throw new AppError(400, "BAD_PERIOD", `${period} hasn't started yet.`);
  const seller = await getSellerOrDefaults(company);
  const gstin = pickRegistration(company, seller, gstinIn, layout !== "register");

  if (layout === "b2b") {
    const rows = await prisma.$queryRaw<InvoiceCsvRow[]>(invoiceCsvRows(company, p.from, p.toExclusive, ["issued", "paid"], gstin, ["b2b", "sez"]));
    if (rows.length > CSV_ROW_CAP) throw tooMany();
    const out: unknown[][] = [[...GSTR1_B2B_HEADERS]];
    for (const r of rows) {
      out.push([
        r.buyer_gstin ?? "", r.buyer_name ?? "", r.number, gstr1Date(day(r.issue_date)), csvMoney(r.total_paise), pos(r), "N",
        "", supplyType(r.section), "", ratePct(r.gst_rate_bp), csvMoney(r.taxable_paise), csvMoney(0),
        csvMoney(r.igst_paise), csvMoney(r.cgst_paise), csvMoney(r.sgst_paise),
      ]);
    }
    return { filename: `gstr1-b2b-${gstin}-${period}.csv`, body: csvDocument(out) };
  }

  if (layout === "cdnr") {
    const rows = await prisma.$queryRaw<CreditNoteCsvRow[]>(creditNoteCsvRows(company, p.from, p.toExclusive, ["issued"], gstin, ["b2b", "sez"]));
    if (rows.length > CSV_ROW_CAP) throw tooMany();
    const out: unknown[][] = [[...GSTR1_CDNR_HEADERS]];
    for (const r of rows) {
      out.push([
        r.buyer_gstin ?? "", r.buyer_name ?? "", r.number, gstr1Date(day(r.issue_date)), "C", pos(r), "N", supplyType(r.section),
        csvMoney(r.total_paise), "", ratePct(r.gst_rate_bp), csvMoney(r.taxable_paise), csvMoney(0),
        csvMoney(r.igst_paise), csvMoney(r.cgst_paise), csvMoney(r.sgst_paise),
      ]);
    }
    return { filename: `gstr1-cdnr-${gstin}-${period}.csv`, body: csvDocument(out) };
  }

  // register: every section, every registration unless one is named; cancelled documents listed
  // with blank amounts (they are not part of the net), credit notes NEGATIVE, so each money
  // column sums to the net shown on the page for the period.
  const inv = await prisma.$queryRaw<InvoiceCsvRow[]>(invoiceCsvRows(company, p.from, p.toExclusive, ["issued", "paid", "cancelled"], gstin, null));
  const cns = await prisma.$queryRaw<CreditNoteCsvRow[]>(creditNoteCsvRows(company, p.from, p.toExclusive, ["issued", "cancelled"], gstin, null));
  if (inv.length + cns.length > CSV_ROW_CAP) throw tooMany();
  type Line = { date: string; order: number; number: string; cells: unknown[] };
  const lines: Line[] = [];
  const money = (live: boolean, paise: number, sign: 1 | -1) => (live ? csvMoney(sign * paise) : "");
  for (const r of inv) {
    const live = r.status !== "cancelled";
    lines.push({
      date: day(r.issue_date), order: 0, number: r.number,
      cells: [
        r.gstin, r.section, "Tax invoice", r.number, day(r.issue_date), r.status, r.buyer_gstin ?? "", r.buyer_name ?? "", pos(r), r.tax_mode, ratePct(r.gst_rate_bp),
        money(live, r.taxable_paise, 1), money(live, r.cgst_paise, 1), money(live, r.sgst_paise, 1), money(live, r.igst_paise, 1),
        money(live, r.round_off_paise, 1), money(live, r.total_paise, 1), "", live ? "" : day(r.cancelled_on),
      ],
    });
  }
  for (const r of cns) {
    const live = r.status === "issued";
    lines.push({
      date: day(r.issue_date), order: 1, number: r.number,
      cells: [
        r.gstin, r.section, "Credit note", r.number, day(r.issue_date), r.status, r.buyer_gstin ?? "", r.buyer_name ?? "", pos(r), r.tax_mode, ratePct(r.gst_rate_bp),
        money(live, r.taxable_paise, -1), money(live, r.cgst_paise, -1), money(live, r.sgst_paise, -1), money(live, r.igst_paise, -1),
        live ? csvMoney(0) : "", money(live, r.total_paise, -1), r.invoice_number ?? "", live ? "" : day(r.cancelled_on),
      ],
    });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  return {
    filename: `sales-register-${company}${gstin ? `-${gstin}` : ""}-${period}.csv`,
    body: csvDocument([[...REGISTER_HEADERS], ...lines.map((l) => l.cells)]),
  };
}

export async function buildTdsCsv(company: CompanyKey, fy: string): Promise<{ filename: string; body: Buffer }> {
  const fb = fyBounds(fy)!;
  const b: Bounds = { from: fb.startDay, to: fb.endExclusive };
  const q5 = await prisma.$queryRaw<Q5Row[]>(Q5(company, b));
  const q6 = await prisma.$queryRaw<Q6Row[]>(Q6(company, b));
  const ids = [...new Set(q5.map((r) => r.client_id))];
  const names: ClientName[] = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: NAME_SELECT }) : [];
  const clients = tdsClients(q5, q6, new Map(names.map((c) => [c.id, c])), Number.POSITIVE_INFINITY);
  const out: unknown[][] = [[...TDS_HEADERS]];
  for (const c of clients) {
    out.push([
      c.companyName, c.legalName ?? "", c.pan ?? "", c.panSource ?? "", c.gstin ?? "",
      ...c.quarters.map((q) => csvMoney(q)), csvMoney(c.totalPaise), c.receipts, c.rates.map((r) => r.label).join("; "),
    ]);
  }
  return { filename: `tds-by-client-${company}-${fy}.csv`, body: csvDocument(out) };
}
