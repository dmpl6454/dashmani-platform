import { prisma, Prisma } from "@dashmani/db";
import {
  COMPANY_KEYS,
  financialYear,
  fyBounds,
  normaliseDocNumber,
  periodBounds,
  RECON_MAX_ROWS,
  reconInr,
  SALES_COMPANIES,
  sellerRegistrations,
  type CompanyKey,
  type GstStatus,
} from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { sha256Hex } from "../../../middleware/upload-private";
import { pickRegistration } from "../accounts.service";
import { SECTION_SQL } from "../accounts-sql";
import { dateToDay, dayToDate, logSalesEvent, toSafeNumber } from "../common";
import { getSellerOrDefaults } from "../settings.service";
import { cleanFileName, withParseSlot } from "./read";
import { readGstr1File } from "./files";
import { GSTR1_SECTIONS, TOTALS_ONLY_SECTIONS, type Gstr1Section, type SectionTotals } from "./parse-gstr1";
import { matchGstr1, type BookDoc, type ElsewhereDoc, type FiledIn, type GstMatchResult, type OtherPeriodKey } from "./match-gstr1";

// Reconcile → GST · GSTR-1 (spec-reconcile §4.5–4.8, §5.2). Books are ONE registration's
// documents (COALESCE(i.seller_snapshot->>'gstin','') = $gstin) — keys never cross GSTINs.
// Writes only sales_gstr1_uploads / sales_gstr1_docs (never updated or deleted).

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const tooManyBooks = () => new AppError(422, "TOO_MANY_ROWS", "This period has more than 20,000 documents in the portal — pick a shorter period.");

/** "2026-10" / "2026-27-Q3" → bounds; month or quarter only, started. */
export function gstPeriod(p: string, today: string) {
  const b = periodBounds(p);
  if (!b || b.kind === "year") throw new AppError(400, "BAD_PERIOD", "Pick a month (2026-10) or a quarter (2026-27-Q3).");
  if (b.from > today) throw new AppError(400, "BAD_PERIOD", `${p} hasn't started yet.`);
  return { key: p, ...b };
}
/** The last completed month before today. */
export function defaultGstPeriod(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
/** MMYYYY of a period's last month (a GSTR-1's fp). */
function lastMonthFp(b: { toExclusive: string }): string {
  const d = new Date(Date.parse(`${b.toExclusive}T00:00:00Z`) - 86_400_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${d.getUTCFullYear()}`;
}
const fpLabel = (fp: string) => `${MONTHS[Number(fp.slice(0, 2)) - 1] ?? fp} ${fp.slice(2)}`;
function nextPeriodKey(b: { kind: string; toExclusive: string; fy: string }, key: string): string {
  if (b.kind === "month") return b.toExclusive.slice(0, 7);
  const q = Number(key.slice(-1));
  if (q < 4) return `${key.slice(0, 7)}-Q${q + 1}`;
  const y = Number(key.slice(0, 4)) + 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}-Q1`;
}

function regLabel(r: { label: string; city: string | null }) { return r.city ?? r.label; }

export interface GstUploadRow { id: string; format: string; fileName: string; fileSha256: string; sections: string[]; counts: Record<string, number>; taxColumns: boolean; warnings: string[]; errorCount: number; current: string[]; uploadedByName: string | null; createdAt: string }
export interface GstUploadResult { upload: GstUploadRow; duplicate: boolean; madeCurrent: boolean }

type UploadRec = Prisma.SalesGstr1UploadGetPayload<Record<string, never>>;
/** For each section: the upload with the newest current_since that states it. */
function currentBySection(ups: UploadRec[]): Map<Gstr1Section, UploadRec> {
  const sorted = [...ups].sort((a, b) => b.currentSince.getTime() - a.currentSince.getTime() || (a.id < b.id ? 1 : -1));
  const out = new Map<Gstr1Section, UploadRec>();
  for (const u of sorted) for (const s of (u.sections as string[]) as Gstr1Section[]) if (!out.has(s)) out.set(s, u);
  return out;
}
function uploadView(u: UploadRec, cur: Map<Gstr1Section, UploadRec>, names: Map<string, string>): GstUploadRow {
  const errs = (u.errorRows as { count?: number } | null) ?? null;
  return { id: u.id, format: u.format, fileName: u.fileName, fileSha256: u.fileSha256, sections: u.sections as string[], counts: u.counts as Record<string, number>, taxColumns: u.taxColumns,
    warnings: (u.warnings as string[] | null) ?? [], errorCount: errs?.count ?? 0, current: [...cur.entries()].filter(([, x]) => x.id === u.id).map(([s]) => s),
    uploadedByName: names.get(u.uploadedById) ?? null, createdAt: u.createdAt.toISOString() };
}
async function userNames(ids: string[]) {
  const rows = ids.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ─── Upload ──────────────────────────────────────────────────────────────────────────────────

export async function uploadGstr1(file: { buffer: Buffer; originalname: string; size: number } | undefined, body: { gstin?: string; period: string; acceptWarnings: boolean }, company: CompanyKey, actorId: string, today: string): Promise<{ status: number; result: GstUploadResult }> {
  if (!file) throw new AppError(400, "NO_FILE", "Choose the file to upload.");
  const seller = await getSellerOrDefaults(company);
  const gstin = pickRegistration(company, seller, body.gstin ?? null, true)!;
  const p = gstPeriod(body.period, today);
  const regs = sellerRegistrations(seller).filter((r) => !!r.gstin);
  const reg = regs.find((r) => r.gstin!.toUpperCase() === gstin)!;

  const report = await withParseSlot(() => readGstr1File(file.buffer));
  if (report.blockers[0]) throw new AppError(422, report.blockers[0].code, report.blockers[0].message);
  if (report.gstin && report.gstin !== gstin) {
    const other = regs.find((r) => r.gstin!.toUpperCase() === report.gstin);
    throw new AppError(422, "GST_WRONG_GSTIN", other
      ? `This GSTR-1 is for ${report.gstin} (${regLabel(other)}) — choose that registration above.`
      : `This GSTR-1 is for ${report.gstin}, which is not one of ${SALES_COMPANIES[company].short}'s registrations.`);
  }
  if (report.returnPeriod && report.returnPeriod !== lastMonthFp(p)) {
    throw new AppError(422, "GST_WRONG_PERIOD", `This GSTR-1 is for ${fpLabel(report.returnPeriod)}, not ${p.label} — choose ${MONTHS[Number(report.returnPeriod.slice(0, 2)) - 1]} above.`);
  }
  const hasOther = Object.values(report.otherSections).some((t) => (t?.docs ?? 0) > 0);
  if (!report.items.length && !hasOther && report.format !== "json") {
    throw new AppError(422, "RECON_FILE_UNREADABLE", "No GSTR-1 invoices or notes were found — is this the GSTR-1 JSON or its b2b/cdnr sheet?");
  }
  const warnings = [...report.warnings];
  if (report.errorCount) warnings.push(`${report.errorCount} row${report.errorCount === 1 ? "" : "s"} could not be read — they are listed with the upload.`);
  if (warnings.length && !body.acceptWarnings) throw new AppError(409, "WARNINGS_NOT_ACCEPTED", `${warnings.join(" ")} Press Upload anyway to keep it.`);

  const sha = sha256Hex(file.buffer);
  const fileName = cleanFileName(file.originalname, "gstr1.json");
  const counts = { b2b: report.items.filter((d) => d.section === "b2b").length, cdnr: report.items.filter((d) => d.section === "cdnr").length };
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`recon:gst:${company}:${gstin}:${p.key}`}))`);
    const all = await tx.salesGstr1Upload.findMany({ where: { companyKey: company, gstin, period: p.key } });
    const existing = all.find((u) => u.fileSha256 === sha);
    if (existing) {
      const cur = currentBySection(all);
      const isCurrent = (existing.sections as string[]).every((s) => cur.get(s as Gstr1Section)?.id === existing.id);
      if (isCurrent) return { upload: existing, duplicate: true, madeCurrent: false };
      const upd = await tx.salesGstr1Upload.update({ where: { id: existing.id }, data: { currentSince: new Date() } });
      await logSalesEvent(tx, { entityType: "gst_upload", entityId: existing.id, actorId, action: "made_current", note: `${existing.fileName} · ${gstin} · ${p.label}` });
      return { upload: upd, duplicate: true, madeCurrent: true };
    }
    const up = await tx.salesGstr1Upload.create({
      data: {
        companyKey: company, gstin, period: p.key, format: report.format, fileName, fileSha256: sha, fileBytes: file.size, returnPeriod: report.returnPeriod,
        sections: report.sections, counts, otherSections: report.otherSections as unknown as Prisma.InputJsonValue, taxColumns: report.taxColumns,
        warnings: warnings as unknown as Prisma.InputJsonValue, errorRows: { rows: report.errors, count: report.errorCount } as unknown as Prisma.InputJsonValue, uploadedById: actorId,
      },
    });
    for (let i = 0; i < report.items.length; i += 1000) {
      await tx.salesGstr1Doc.createMany({
        data: report.items.slice(i, i + 1000).map((d) => ({
          uploadId: up.id, section: d.section, rowRef: d.rowRef, ctin: d.ctin, receiverName: d.receiverName, number: d.number, numberKey: d.numberKey,
          docDate: d.docDate ? dayToDate(d.docDate) : null, noteType: d.noteType, origNumber: d.origNumber, invType: d.invType, pos: d.pos, reverseCharge: d.reverseCharge,
          valuePaise: BigInt(d.valuePaise), taxablePaise: BigInt(d.taxablePaise), igstPaise: d.igstPaise === null ? null : BigInt(d.igstPaise),
          cgstPaise: d.cgstPaise === null ? null : BigInt(d.cgstPaise), sgstPaise: d.sgstPaise === null ? null : BigInt(d.sgstPaise), cessPaise: d.cessPaise === null ? null : BigInt(d.cessPaise),
          ratesBp: d.ratesBp,
        })),
      });
    }
    await logSalesEvent(tx, { entityType: "gst_upload", entityId: up.id, actorId, action: "uploaded", note: `${fileName} · ${gstin} · ${p.label} · ${counts.b2b} b2b · ${counts.cdnr} cdnr` });
    return { upload: up, duplicate: false, madeCurrent: false };
  }, { timeout: 30_000, maxWait: 10_000 });
  void reg;
  const all = await prisma.salesGstr1Upload.findMany({ where: { companyKey: company, gstin, period: p.key } });
  const names = await userNames([out.upload.uploadedById]);
  return { status: out.duplicate ? 200 : 201, result: { upload: uploadView(out.upload, currentBySection(all), names), duplicate: out.duplicate, madeCurrent: out.madeCurrent } };
}

// ─── The view ────────────────────────────────────────────────────────────────────────────────

interface BookRow { id: string; number: string; status: string; issue_date: Date; tax_mode: string; gst_rate_bp: number; place_of_supply_code: string | null; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; cancelled_on: Date | null; cancel_reason: string | null; buyer_gstin: string | null; buyer_name: string | null; buyer_state: string | null; section: string }
interface CnRow { id: string; number: string; status: string; issue_date: Date; gst_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; cancelled_on: Date | null; invoice_id: string; invoice_number: string | null; place_of_supply_code: string | null; buyer_gstin: string | null; buyer_name: string | null; buyer_state: string | null; section: string }

export interface GstReconView {
  company: CompanyKey; gstin: string; registrationLabel: string; registrations: Array<{ gstin: string; label: string }>;
  period: { key: string; label: string; from: string; toExclusive: string; fy: string; kind: "month" | "quarter" };
  periodOptions: Array<{ key: string; label: string }>;
  uploads: GstUploadRow[]; periodsWithUploads: string[]; taxColumns: boolean;
  counts: GstMatchResult["counts"]; sections: GstMatchResult["sections"]; rows: GstMatchResult["rows"]; importLink: boolean;
  todo: Array<{ code: string; sentence: string; count: number; paise: number | null; href: string | null }>;
}

export async function loadGstBooks(company: CompanyKey, gstin: string, wFrom: string, wTo: string): Promise<BookDoc[]> {
  const inv = await prisma.$queryRaw<BookRow[]>(Prisma.sql`
    SELECT i.id, i.number, i.status, i.issue_date, i.tax_mode, i.gst_rate_bp, i.place_of_supply_code,
           i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise, i.total_paise,
           (i.cancelled_at + interval '330 minutes')::date AS cancelled_on, i.cancel_reason,
           NULLIF(i.buyer_snapshot->>'gstin','') AS buyer_gstin, i.buyer_snapshot->>'legalName' AS buyer_name,
           NULLIF(i.buyer_snapshot->>'stateCode','') AS buyer_state, ${SECTION_SQL} AS section
    FROM sales_invoices i
    WHERE i.company_key = ${company} AND i.kind = 'tax_invoice' AND i.number IS NOT NULL
      AND i.status IN ('issued','paid','cancelled') AND COALESCE(i.seller_snapshot->>'gstin','') = ${gstin}
      AND i.issue_date >= ${wFrom}::date AND i.issue_date < ${wTo}::date
    LIMIT ${RECON_MAX_ROWS + 1}`);
  const cns = await prisma.$queryRaw<CnRow[]>(Prisma.sql`
    SELECT cn.id, cn.number, cn.status, cn.issue_date, cn.gst_rate_bp, cn.taxable_paise, cn.cgst_paise, cn.sgst_paise, cn.igst_paise, cn.total_paise,
           (cn.cancelled_at + interval '330 minutes')::date AS cancelled_on, i.id AS invoice_id, i.number AS invoice_number, i.place_of_supply_code,
           NULLIF(i.buyer_snapshot->>'gstin','') AS buyer_gstin, i.buyer_snapshot->>'legalName' AS buyer_name,
           NULLIF(i.buyer_snapshot->>'stateCode','') AS buyer_state, ${SECTION_SQL} AS section
    FROM sales_credit_notes cn JOIN sales_invoices i ON i.id = cn.invoice_id
    WHERE i.company_key = ${company} AND cn.status IN ('issued','cancelled') AND COALESCE(i.seller_snapshot->>'gstin','') = ${gstin}
      AND cn.issue_date >= ${wFrom}::date AND cn.issue_date < ${wTo}::date
    LIMIT ${RECON_MAX_ROWS + 1}`);
  if (inv.length + cns.length > RECON_MAX_ROWS) throw tooManyBooks();
  return [
    ...inv.map((r): BookDoc => ({ id: r.id, kind: "invoice", number: r.number, status: r.status, date: dateToDay(r.issue_date)!, cancelledOn: dateToDay(r.cancelled_on), cancelReason: r.cancel_reason,
      buyerGstin: r.buyer_gstin, buyerName: r.buyer_name, pos: r.place_of_supply_code ?? r.buyer_state, section: r.section, valuePaise: r.total_paise, taxablePaise: r.taxable_paise,
      igstPaise: r.igst_paise, cgstPaise: r.cgst_paise, sgstPaise: r.sgst_paise, ratesBp: [r.gst_rate_bp], invoiceNumber: null, invoiceId: null })),
    ...cns.map((r): BookDoc => ({ id: r.id, kind: "credit_note", number: r.number, status: r.status, date: dateToDay(r.issue_date)!, cancelledOn: dateToDay(r.cancelled_on), cancelReason: null,
      buyerGstin: r.buyer_gstin, buyerName: r.buyer_name, pos: r.place_of_supply_code ?? r.buyer_state, section: r.section, valuePaise: r.total_paise, taxablePaise: r.taxable_paise,
      igstPaise: r.igst_paise, cgstPaise: r.cgst_paise, sgstPaise: r.sgst_paise, ratesBp: [r.gst_rate_bp], invoiceNumber: r.invoice_number, invoiceId: r.invoice_id })),
  ];
}

function periodOptions(today: string) {
  const cur = financialYear(today).label;
  const prev = `${Number(cur.slice(0, 4)) - 1}-${cur.slice(2, 4)}`;
  const out: Array<{ key: string; label: string }> = [];
  for (const fy of [cur, prev]) {
    const y = Number(fy.slice(0, 4));
    const months: string[] = [];
    for (let k = 0; k < 12; k++) { const m = ((3 + k) % 12) + 1; months.push(`${m >= 4 ? y : y + 1}-${String(m).padStart(2, "0")}`); }
    for (const m of months.reverse()) { const b = periodBounds(m)!; if (b.from <= today) out.push({ key: m, label: b.label }); }
    for (const q of [4, 3, 2, 1]) { const k = `${fy}-Q${q}`; const b = periodBounds(k)!; if (b.from <= today) out.push({ key: k, label: b.label }); }
  }
  return out;
}

export async function getGstRecon(company: CompanyKey, gstinIn: string | undefined, periodIn: string | undefined, today: string): Promise<GstReconView> {
  const seller = await getSellerOrDefaults(company);
  const regs = sellerRegistrations(seller).filter((r) => !!r.gstin);
  if (!regs.length) throw new AppError(400, "PICK_REGISTRATION", `${SALES_COMPANIES[company].short} has no GST registration in Settings — add its GSTIN first.`);
  // A GET without a GSTIN shows the principal registration (the page then offers the others).
  const gstin = gstinIn ? pickRegistration(company, seller, gstinIn, true)! : regs[0].gstin!.toUpperCase();
  const reg = regs.find((r) => r.gstin!.toUpperCase() === gstin)!;
  const p = gstPeriod(periodIn ?? defaultGstPeriod(today), today);
  const wFrom = `${Number(p.from.slice(0, 4)) - 1}${p.from.slice(4)}`;
  const wTo = `${Number(p.toExclusive.slice(0, 4)) + 1}${p.toExclusive.slice(4)}`;

  const ups = await prisma.salesGstr1Upload.findMany({ where: { companyKey: company, gstin, period: p.key }, orderBy: [{ currentSince: "desc" }, { id: "desc" }] });
  const cur = currentBySection(ups);
  const names = await userNames(ups.map((u) => u.uploadedById));
  const filed: FiledIn[] = [];
  for (const sec of ["b2b", "cdnr"] as const) {
    const u = cur.get(sec);
    if (!u) continue;
    const docs = await prisma.salesGstr1Doc.findMany({ where: { uploadId: u.id, section: sec }, orderBy: { rowRef: "asc" } });
    for (const d of docs) filed.push({
      id: d.id, uploadId: d.uploadId, section: sec, rowRef: d.rowRef, ctin: d.ctin, receiverName: d.receiverName, number: d.number, numberKey: d.numberKey, docDate: dateToDay(d.docDate),
      noteType: d.noteType, origNumber: d.origNumber, invType: d.invType, pos: d.pos, reverseCharge: d.reverseCharge, valuePaise: toSafeNumber(d.valuePaise), taxablePaise: toSafeNumber(d.taxablePaise),
      igstPaise: d.igstPaise === null ? null : toSafeNumber(d.igstPaise), cgstPaise: d.cgstPaise === null ? null : toSafeNumber(d.cgstPaise), sgstPaise: d.sgstPaise === null ? null : toSafeNumber(d.sgstPaise),
      cessPaise: d.cessPaise === null ? null : toSafeNumber(d.cessPaise), ratesBp: (d.ratesBp as number[]) ?? [],
    });
  }
  const filedOther: Partial<Record<(typeof TOTALS_ONLY_SECTIONS)[number], SectionTotals>> = {};
  for (const sec of TOTALS_ONLY_SECTIONS) {
    const u = cur.get(sec);
    if (!u) continue;
    const t = (u.otherSections as Record<string, SectionTotals> | null)?.[sec];
    filedOther[sec] = t ?? { docs: 0, valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };
  }
  const books = await loadGstBooks(company, gstin, wFrom, wTo);

  // Elsewhere: exact key0 of the filed numbers, in the company's other registrations, the other company, proformas.
  const keys = [...new Set(filed.map((f) => normaliseDocNumber(f.number).key0))];
  const elsewhere: ElsewhereDoc[] = [];
  if (keys.length) {
    const rows = await prisma.$queryRaw<Array<{ id: string; number: string; key0: string; kind: string; company_key: string; gstin: string }>>(Prisma.sql`
      SELECT i.id, i.number, upper(regexp_replace(i.number, '\\s', '', 'g')) AS key0, i.kind, i.company_key, COALESCE(i.seller_snapshot->>'gstin','') AS gstin
      FROM sales_invoices i
      WHERE i.number IS NOT NULL AND upper(regexp_replace(i.number, '\\s', '', 'g')) = ANY(${keys})
        AND NOT (i.company_key = ${company} AND i.kind = 'tax_invoice' AND COALESCE(i.seller_snapshot->>'gstin','') = ${gstin})
      LIMIT 5000`);
    const allRegs = new Map<string, string>();
    for (const ck of COMPANY_KEYS) for (const r of sellerRegistrations(await getSellerOrDefaults(ck))) if (r.gstin) allRegs.set(r.gstin.toUpperCase(), regLabel(r));
    for (const r of rows) {
      const kind: ElsewhereDoc["kind"] = r.kind === "proforma" ? "proforma" : r.company_key !== company ? "company" : "registration";
      elsewhere.push({ key0: r.key0, kind, number: r.number, invoiceId: r.id, companyKey: r.company_key, gstin: r.gstin || null,
        label: kind === "company" ? SALES_COMPANIES[r.company_key as CompanyKey]?.short ?? r.company_key : allRegs.get(r.gstin) ?? r.gstin });
    }
  }
  // Other periods of the same GSTIN (current and previous FY): the current b2b/cdnr docs' keys.
  const otherUps = await prisma.salesGstr1Upload.findMany({ where: { companyKey: company, gstin, NOT: { period: p.key } }, orderBy: [{ currentSince: "desc" }] });
  const byPeriod = new Map<string, UploadRec[]>();
  for (const u of otherUps) byPeriod.set(u.period, [...(byPeriod.get(u.period) ?? []), u]);
  const otherPeriods: OtherPeriodKey[] = [];
  for (const [period, list] of byPeriod) {
    const c = currentBySection(list);
    const label = periodBounds(period)?.label ?? period;
    for (const sec of ["b2b", "cdnr"] as const) {
      const u = c.get(sec);
      if (!u) continue;
      const docs = await prisma.salesGstr1Doc.findMany({ where: { uploadId: u.id, section: sec }, select: { numberKey: true } });
      for (const d of docs) otherPeriods.push({ period, label, section: sec, numberKey: d.numberKey });
    }
  }
  const nextKey = nextPeriodKey(p, p.key);
  const nextB = periodBounds(nextKey);
  const m = matchGstr1({ gstin, period: { key: p.key, label: p.label, from: p.from, toExclusive: p.toExclusive }, books, filed, elsewhere, otherPeriods,
    nextPeriod: { label: nextB?.label ?? nextKey, uploaded: byPeriod.has(nextKey) }, filedOther });

  const fyStart = Number(financialYear(today).label.slice(0, 4)) - 1;
  const periodsWithUploads = [...new Set([...byPeriod.keys(), ...(ups.length ? [p.key] : [])])].filter((k) => { const b = periodBounds(k); return !!b && Number(b.fy.slice(0, 4)) >= fyStart; }).sort();
  const c = m.counts;
  const todo: GstReconView["todo"] = [];
  if (!ups.length) todo.push({ code: "upload", sentence: `Upload the GSTR-1 you filed for ${p.label} to check it against the invoices in the portal.`, count: 0, paise: null, href: null });
  const notFiled = m.rows.filter((r) => r.status === "not_filed");
  if (notFiled.length) todo.push({ code: "not_filed", sentence: `Add ${notFiled.length} document${notFiled.length === 1 ? "" : "s"} to your next GSTR-1`, count: notFiled.length, paise: notFiled.reduce((s, r) => s + (r.books?.valuePaise ?? 0), 0), href: null });
  const fix = c.value_mismatch + c.wrong_recipient + c.cancelled_but_filed + c.wrong_period;
  if (fix) todo.push({ code: "correct", sentence: `Correct ${fix} filed document${fix === 1 ? "" : "s"}`, count: fix, paise: null, href: null });
  if (c.not_in_books) todo.push({ code: "not_in_books", sentence: `${c.not_in_books} filed document${c.not_in_books === 1 ? " is" : "s are"} not in the portal`, count: c.not_in_books, paise: null, href: null });
  for (const s of m.sections) if (s.differs && s.note) todo.push({ code: `section_${s.section}`, sentence: s.note, count: 1, paise: s.filed ? s.filed.taxablePaise - s.books.taxablePaise : null, href: null });
  const anyTaxless = ["b2b", "cdnr"].some((s) => cur.get(s as Gstr1Section) && !cur.get(s as Gstr1Section)!.taxColumns);

  return {
    company, gstin, registrationLabel: regLabel(reg), registrations: regs.map((r) => ({ gstin: r.gstin!.toUpperCase(), label: regLabel(r) })),
    period: { key: p.key, label: p.label, from: p.from, toExclusive: p.toExclusive, fy: p.fy, kind: p.kind as "month" | "quarter" },
    periodOptions: periodOptions(today), uploads: ups.map((u) => uploadView(u, cur, names)), periodsWithUploads, taxColumns: !anyTaxless,
    counts: m.counts, sections: m.sections, rows: m.rows.slice(0, 5000), importLink: m.importable, todo,
  };
}

export const GST_STATUS_TEXT: Record<GstStatus, string> = {
  matched: "Matches", matched_note: "Matches (number written differently)", value_mismatch: "Figures differ", wrong_recipient: "Wrong recipient GSTIN",
  wrong_period: "Wrong month", not_filed: "Not filed", not_in_books: "Not in the portal", cancelled_but_filed: "Cancelled here, filed",
};
export { reconInr, GSTR1_SECTIONS };
