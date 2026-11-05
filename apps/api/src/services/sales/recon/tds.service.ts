import { prisma, Prisma } from "@dashmani/db";
import {
  financialYear,
  fyBounds,
  panOf,
  RECON_MAX_ROWS,
  reconDay,
  reconInr,
  SALES_COMPANIES,
  type CompanyKey,
} from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { sha256Hex } from "../../../middleware/upload-private";
import { dateToDay, dayToDate, istDayOf, logSalesEvent, toSafeNumber } from "../common";
import { getSellerOrDefaults } from "../settings.service";
import { cleanFileName, withParseSlot } from "./read";
import { readTdsFile } from "./files";
import { matchTds, resolveTans, type TdsBookItem, type TdsEntryIn, type TanResolution, type TdsMatchResult } from "./match-tds";
import { loadTanMappings, setTan } from "./tan";

// Reconcile → TDS · 26AS (spec-reconcile §4.4, §5.1, §6). Reads: bounded SELECTs, company-scoped,
// recorded receipts only. Writes: only sales_tds_uploads / sales_tds_entries (never updated or
// deleted) and TAN mappings through setTan(). Never a money table.

const RECON_LOCK = (kind: string, company: string, scope: string) => Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`recon:${kind}:${company}:${scope}`}))`;
const tooManyBooks = () => new AppError(422, "TOO_MANY_ROWS", "This period has more than 20,000 documents in the portal — pick a shorter period.");

export interface TdsUploadRow {
  id: string; format: string; fileName: string; fileSha256: string; fileBytes: number; pan: string | null; asOn: string | null; entryCount: number; deductorCount: number;
  totals: { amountPaidPaise: number; tdsPaise: number; depositedPaise: number }; warnings: string[]; errorRows: Array<{ ref: string; message: string }>; errorCount: number;
  current: boolean; uploadedByName: string | null; createdAt: string; currentSince: string;
}

type UploadRec = Prisma.SalesTdsUploadGetPayload<Record<string, never>>;

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function uploadView(u: UploadRec, currentId: string | null, names: Map<string, string>): TdsUploadRow {
  const errs = (u.errorRows as { rows?: Array<{ ref: string; message: string }>; count?: number } | null) ?? null;
  return {
    id: u.id, format: u.format, fileName: u.fileName, fileSha256: u.fileSha256, fileBytes: u.fileBytes, pan: u.pan, asOn: dateToDay(u.asOn),
    entryCount: u.entryCount, deductorCount: u.deductorCount,
    totals: { amountPaidPaise: toSafeNumber(u.amountPaidPaise), tdsPaise: toSafeNumber(u.tdsPaise), depositedPaise: toSafeNumber(u.depositedPaise) },
    warnings: (u.warnings as string[] | null) ?? [], errorRows: errs?.rows ?? [], errorCount: errs?.count ?? 0,
    current: u.id === currentId, uploadedByName: names.get(u.uploadedById) ?? null, createdAt: u.createdAt.toISOString(), currentSince: u.currentSince.toISOString(),
  };
}

function companyPan(seller: { pan?: string | null; gstin?: string | null }): string | null {
  return panOf(seller.pan ?? null, seller.gstin ?? null).pan;
}

// ─── Upload ──────────────────────────────────────────────────────────────────────────────────

export interface TdsUploadResult { upload: TdsUploadRow; duplicate: boolean; madeCurrent: boolean; learned: Array<{ tan: string; clientId: string; clientName: string; where: "profile" | "deductors" }> }

export async function uploadTds(file: { buffer: Buffer; originalname: string; size: number } | undefined, body: { fy: string; acceptWarnings: boolean }, company: CompanyKey, actorId: string): Promise<{ status: number; result: TdsUploadResult }> {
  if (!file) throw new AppError(400, "NO_FILE", "Choose the file to upload.");
  const fb = fyBounds(body.fy);
  if (!fb) throw new AppError(400, "BAD_FY", "Pick a financial year like 2025-26.");
  const seller = await getSellerOrDefaults(company);
  const short = SALES_COMPANIES[company].short;
  const ourPan = companyPan(seller);
  if (!ourPan) throw new AppError(422, "COMPANY_PAN_MISSING", `Add ${short}'s PAN or GSTIN in Settings first — 26AS is matched by PAN.`);

  const report = await withParseSlot(() => readTdsFile(file.buffer));
  const blocker = report.blockers[0];
  if (blocker) throw new AppError(422, blocker.code, blocker.message);
  if (report.facts.pan && report.facts.pan !== ourPan) {
    throw new AppError(422, "TDS_WRONG_PAN", `This 26AS is for PAN ${report.facts.pan}, not ${short}'s (${ourPan}) — switch company at the top or upload the right file.`);
  }
  const fileFy = report.facts.financialYear;
  if (fileFy && fileFy !== fb.label) throw new AppError(422, "TDS_WRONG_FY", `This 26AS is for ${fileFy} — choose ${fileFy} above and upload it again.`);
  const inFy = report.items.filter((e) => e.txnDate >= fb.startDay && e.txnDate <= fb.endDay);
  const outside = report.items.filter((e) => !(e.txnDate >= fb.startDay && e.txnDate <= fb.endDay));
  if (report.items.length && !inFy.length) {
    const other = financialYear(report.items[0].txnDate).label;
    throw new AppError(422, "TDS_WRONG_FY", `This 26AS is for ${other} — choose ${other} above and upload it again.`);
  }
  const warnings = [...report.warnings];
  const errorRows = [...report.errors];
  let errorCount = report.errorCount;
  for (const e of outside) {
    errorCount++;
    if (errorRows.length < 50) errorRows.push({ ref: `line ${e.rowNo}`, message: `line ${e.rowNo}: dated ${reconDay(e.txnDate)}, outside ${fb.label}` });
  }
  if (outside.length) warnings.push(`${outside.length} entr${outside.length === 1 ? "y is" : "ies are"} dated outside ${fb.label} and will not be kept.`);
  if (!inFy.length && report.facts.noTransactions !== "yes" && errorCount === 0) {
    throw new AppError(422, "RECON_FILE_UNREADABLE", "No TDS entries were found — is this Form 26AS (TRACES 'Export as Text') or the AIS TDS CSV?");
  }
  if (report.errorCount) warnings.push(`${report.errorCount} line${report.errorCount === 1 ? "" : "s"} could not be read — they are listed with the upload.`);
  if (!report.facts.pan) warnings.push(`The file does not say whose PAN it is — check it is ${short}'s (${ourPan}).`);
  if (warnings.length && !body.acceptWarnings) {
    throw new AppError(409, "WARNINGS_NOT_ACCEPTED", `${warnings.join(" ")} Press Upload anyway to keep it.`);
  }

  const sha = sha256Hex(file.buffer);
  const fileName = cleanFileName(file.originalname, "26as.txt");
  const asOn = report.facts.asOn ?? null;
  const tans = new Set(inFy.map((e) => e.tan));
  const sum = (f: (e: (typeof inFy)[number]) => number) => inFy.reduce((s, e) => s + f(e), 0);

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(RECON_LOCK("tds", company, fb.label));
    const existing = await tx.salesTdsUpload.findUnique({ where: { companyKey_financialYear_fileSha256: { companyKey: company, financialYear: fb.label, fileSha256: sha } } });
    if (existing) {
      const current = await tx.salesTdsUpload.findFirst({ where: { companyKey: company, financialYear: fb.label }, orderBy: [{ currentSince: "desc" }, { id: "desc" }], select: { id: true } });
      if (current?.id === existing.id) return { upload: existing, duplicate: true, madeCurrent: false };
      const upd = await tx.salesTdsUpload.update({ where: { id: existing.id }, data: { currentSince: new Date() } });
      await logSalesEvent(tx, { entityType: "tds_upload", entityId: existing.id, actorId, action: "made_current", note: `${existing.fileName} · ${fb.label}` });
      return { upload: upd, duplicate: true, madeCurrent: true };
    }
    const up = await tx.salesTdsUpload.create({
      data: {
        companyKey: company, financialYear: fb.label, format: report.format, fileName, fileSha256: sha, fileBytes: file.size, pan: report.facts.pan ?? null,
        asOn: asOn ? dayToDate(asOn) : null, entryCount: inFy.length, deductorCount: tans.size,
        amountPaidPaise: BigInt(sum((e) => e.amountPaidPaise)), tdsPaise: BigInt(sum((e) => e.tdsPaise)), depositedPaise: BigInt(sum((e) => e.depositedPaise ?? 0)),
        warnings: warnings as unknown as Prisma.InputJsonValue, errorRows: { rows: errorRows, count: errorCount } as unknown as Prisma.InputJsonValue, uploadedById: actorId,
      },
    });
    for (let i = 0; i < inFy.length; i += 1000) {
      await tx.salesTdsEntry.createMany({
        data: inFy.slice(i, i + 1000).map((e) => ({
          uploadId: up.id, rowNo: e.rowNo, tan: e.tan, deductorName: e.deductorName, section: e.section, txnDate: dayToDate(e.txnDate), quarter: e.quarter,
          bookingStatus: e.bookingStatus, bookingDate: e.bookingDate ? dayToDate(e.bookingDate) : null, remarks: e.remarks,
          amountPaidPaise: BigInt(e.amountPaidPaise), tdsPaise: BigInt(e.tdsPaise), depositedPaise: e.depositedPaise === null ? null : BigInt(e.depositedPaise),
        })),
      });
    }
    await logSalesEvent(tx, { entityType: "tds_upload", entityId: up.id, actorId, action: "uploaded",
      note: `${fileName} · ${fb.label}${asOn ? ` · as on ${reconDay(asOn)}` : ""} · ${inFy.length} entries · ${tans.size} deductors` });
    return { upload: up, duplicate: false, madeCurrent: false };
  }, { timeout: 30_000, maxWait: 10_000 });

  const learned = out.duplicate && !out.madeCurrent ? [] : await learnSureTans(company, fb.label, actorId).catch((err) => {
    console.error("[sales] reconcile TAN learning failed", err);
    return [];
  });
  const names = await userNames([out.upload.uploadedById]);
  return { status: out.duplicate ? 200 : 201, result: { upload: uploadView(out.upload, out.upload.id, names), duplicate: out.duplicate, madeCurrent: out.madeCurrent, learned } };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────────────────────

interface T1Row { key: string; payment_id: string; receipt_number: string; paid_on: Date; client_id: string; invoice_id: string; invoice_number: string | null; kind: string; issue_date: Date | null; taxable_paise: number; total_paise: number; amount_paise: number; tds_paise: number }
interface T2Row { key: string; payment_id: string; receipt_number: string; paid_on: Date; client_id: string; tds_paise: number }

async function currentUpload(company: CompanyKey, fy: string) {
  return prisma.salesTdsUpload.findFirst({ where: { companyKey: company, financialYear: fy }, orderBy: [{ currentSince: "desc" }, { id: "desc" }] });
}

async function loadBooks(company: CompanyKey, fy: string): Promise<{ items: TdsBookItem[]; byReceiptDate: number }> {
  const fb = fyBounds(fy)!;
  const lo = new Date(Date.parse(`${fb.startDay}T00:00:00Z`) - 92 * 86_400_000).toISOString().slice(0, 10);
  const hi = new Date(Date.parse(`${fb.endExclusive}T00:00:00Z`) + 92 * 86_400_000).toISOString().slice(0, 10);
  const t1 = await prisma.$queryRaw<T1Row[]>(Prisma.sql`
    SELECT a.id AS key, p.id AS payment_id, p.number AS receipt_number, p.paid_on, p.client_id,
           i.id AS invoice_id, i.number AS invoice_number, i.kind, i.issue_date, i.taxable_paise, i.total_paise, a.amount_paise, a.tds_paise
    FROM sales_payment_allocations a
    JOIN sales_payments p ON p.id = a.payment_id AND p.status = 'recorded'
    JOIN sales_invoices i ON i.id = a.invoice_id
    WHERE p.company_key = ${company} AND a.tds_paise > 0
      AND ((i.kind = 'tax_invoice' AND i.issue_date >= ${lo}::date AND i.issue_date < ${hi}::date)
           OR (p.paid_on >= ${lo}::date AND p.paid_on < ${hi}::date))
    ORDER BY p.paid_on, p.number, i.number LIMIT ${RECON_MAX_ROWS + 1}`);
  const t2 = await prisma.$queryRaw<T2Row[]>(Prisma.sql`
    SELECT 'pay:' || p.id AS key, p.id AS payment_id, p.number AS receipt_number, p.paid_on, p.client_id,
           (p.tds_paise - COALESCE(SUM(a.tds_paise), 0))::int AS tds_paise
    FROM sales_payments p LEFT JOIN sales_payment_allocations a ON a.payment_id = p.id
    WHERE p.company_key = ${company} AND p.status = 'recorded' AND p.tds_paise > 0
      AND p.paid_on >= ${lo}::date AND p.paid_on < ${hi}::date
    GROUP BY p.id HAVING p.tds_paise - COALESCE(SUM(a.tds_paise), 0) > 0 LIMIT ${RECON_MAX_ROWS + 1}`);
  if (t1.length + t2.length > RECON_MAX_ROWS) throw tooManyBooks();
  const [agg] = await prisma.$queryRaw<Array<{ tds: bigint | null }>>(Prisma.sql`
    SELECT SUM(p.tds_paise)::bigint AS tds FROM sales_payments p
    WHERE p.company_key = ${company} AND p.status = 'recorded' AND p.paid_on >= ${fb.startDay}::date AND p.paid_on < ${fb.endExclusive}::date`);
  const items: TdsBookItem[] = [
    ...t1.map((r) => ({ key: r.key, paymentId: r.payment_id, receiptNumber: r.receipt_number, paidOn: dateToDay(r.paid_on)!, clientId: r.client_id, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number,
      invoiceKind: r.kind, issueDate: dateToDay(r.issue_date), taxablePaise: r.taxable_paise, totalPaise: r.total_paise, amountPaise: r.amount_paise, tdsPaise: r.tds_paise, t2: false })),
    ...t2.map((r) => ({ key: r.key, paymentId: r.payment_id, receiptNumber: r.receipt_number, paidOn: dateToDay(r.paid_on)!, clientId: r.client_id, invoiceId: null, invoiceNumber: null,
      invoiceKind: null, issueDate: null, taxablePaise: null, totalPaise: null, amountPaise: null, tdsPaise: r.tds_paise, t2: true })),
  ];
  return { items, byReceiptDate: toSafeNumber(agg?.tds ?? 0) };
}

async function loadEntries(uploadId: string): Promise<TdsEntryIn[]> {
  const rows = await prisma.salesTdsEntry.findMany({ where: { uploadId }, orderBy: { rowNo: "asc" } });
  return rows.map((e) => ({
    id: e.id, rowNo: e.rowNo, tan: e.tan, deductorName: e.deductorName, section: e.section, txnDate: dateToDay(e.txnDate)!, quarter: e.quarter as 1 | 2 | 3 | 4,
    bookingStatus: e.bookingStatus, amountPaidPaise: toSafeNumber(e.amountPaidPaise), tdsPaise: toSafeNumber(e.tdsPaise), depositedPaise: e.depositedPaise === null ? null : toSafeNumber(e.depositedPaise),
  }));
}

async function resolveFor(fy: string, entries: TdsEntryIn[], items: TdsBookItem[]) {
  const tans = [...new Set(entries.map((e) => e.tan))];
  const mappings = await loadTanMappings(tans);
  const known = new Set([...mappings.profiles.map((p) => p.tan), ...mappings.deductors.map((d) => d.tan)]);
  const needAll = tans.some((t) => !known.has(t));
  const ids = new Set<string>([...items.map((b) => b.clientId), ...mappings.profiles.map((p) => p.clientId), ...mappings.deductors.map((d) => d.clientId).filter((x): x is string => !!x)]);
  const clients = await prisma.client.findMany({
    where: needAll ? {} : { id: { in: [...ids] } },
    select: { id: true, companyName: true, email: true, billingProfile: { select: { legalName: true, pan: true, gstin: true, billingEmail: true, tan: true } } },
    take: 5000,
    orderBy: { id: "asc" },
  });
  const resolved = resolveTans({ fy, entries, items, profiles: mappings.profiles, deductors: mappings.deductors, clients: clients.map((c) => ({ id: c.id, companyName: c.companyName, legalName: c.billingProfile?.legalName ?? null })) });
  return { resolved, clients, mappings };
}

/** After a new (or made-current) upload: learn every SURE TAN, one transaction each. Never fails the upload. */
async function learnSureTans(company: CompanyKey, fy: string, actorId: string) {
  const up = await currentUpload(company, fy);
  if (!up) return [];
  const entries = await loadEntries(up.id);
  const { items } = await loadBooks(company, fy);
  const { resolved, clients } = await resolveFor(fy, entries, items);
  const out: TdsUploadResult["learned"] = [];
  for (const t of resolved) {
    if (t.kind !== "unknown" || !t.proposal?.sure) continue;
    const name = clients.find((c) => c.id === t.proposal!.clientId)?.companyName ?? t.proposal.clientName;
    const res = await prisma.$transaction((tx) => setTan(tx, { tan: t.tan, clientId: t.proposal!.clientId, kind: "client", nameSeen: t.name, source: "auto", actorId,
      note: `${t.tan} from Form 26AS ${fy} — ${t.proposal!.why.join("; ")}` }));
    if (res.changed) out.push({ tan: t.tan, clientId: t.proposal.clientId, clientName: name, where: res.where });
  }
  return out;
}

// ─── The view ────────────────────────────────────────────────────────────────────────────────

export interface TdsReconView {
  company: CompanyKey; fy: { label: string; startDay: string; endDay: string }; pan: { company: string | null; file: string | null };
  upload: TdsUploadRow | null; history: TdsUploadRow[]; historyCount: number;
  totals: TdsMatchResult["totals"] & { booksByReceiptDatePaise: number };
  deductors: Array<{ tan: string; name: string; kind: TanResolution["kind"]; clientId: string | null; clientName: string | null; label: string | null; source: TanResolution["source"]; entries: number; tdsPaise: number; proposal: TanResolution["proposal"] }>;
  clients: Array<{ clientId: string; name: string; pan: string | null; tans: string[]; billingEmail: string | null; verdict: TdsMatchResult["clients"][number]["verdict"]; quarters: TdsMatchResult["clients"][number]["quarters"] }>;
  rows: TdsMatchResult["rows"];
  expectedBy: TdsMatchResult["expectedBy"];
  fyOptions: string[];
  todo: Array<{ code: string; sentence: string; count: number; paise: number | null; href: string | null }>;
}

/** Default FY: the current one when it has an upload, else the latest with one, else last FY in Apr–Jun, else the current. */
export async function defaultTdsFy(company: CompanyKey, today: string): Promise<string> {
  const cur = financialYear(today).label;
  const ups = await prisma.salesTdsUpload.findMany({ where: { companyKey: company }, select: { financialYear: true }, distinct: ["financialYear"], orderBy: { financialYear: "desc" } });
  if (ups.some((u) => u.financialYear === cur)) return cur;
  if (ups.length) return ups[0].financialYear;
  const m = Number(today.slice(5, 7));
  if (m >= 4 && m <= 6) return financialYear(`${Number(today.slice(0, 4)) - 1}-12-01`).label;
  return cur;
}

export async function getTdsRecon(company: CompanyKey, fyIn: string | undefined, today: string): Promise<TdsReconView> {
  const fy = fyIn ?? (await defaultTdsFy(company, today));
  const fb = fyBounds(fy);
  if (!fb) throw new AppError(400, "BAD_FY", "Pick a financial year like 2025-26.");
  if (fb.startDay > today) throw new AppError(400, "BAD_FY", `${fy} hasn't started yet.`);
  const seller = await getSellerOrDefaults(company);
  const ourPan = companyPan(seller);
  const ups = await prisma.salesTdsUpload.findMany({ where: { companyKey: company, financialYear: fy }, orderBy: [{ currentSince: "desc" }, { id: "desc" }], take: 11 });
  const current = ups[0] ?? null;
  const historyCount = await prisma.salesTdsUpload.count({ where: { companyKey: company, financialYear: fy } });
  const names = await userNames(ups.map((u) => u.uploadedById));
  const entries = current ? await loadEntries(current.id) : [];
  const { items, byReceiptDate } = await loadBooks(company, fy);
  const { resolved, clients } = await resolveFor(fy, entries, items);
  const asOn = current?.asOn ? dateToDay(current.asOn)! : current ? istDayOf(current.createdAt) : today;
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const m = matchTds({ fy, asOn, ourPan, entries, items, tans: resolved, clients: clients.map((c) => ({ id: c.id, name: c.companyName, legalName: c.billingProfile?.legalName ?? null, pan: panOf(c.billingProfile?.pan ?? null, c.billingProfile?.gstin ?? null).pan, billingEmail: c.billingProfile?.billingEmail ?? c.email ?? null })), hasUpload: !!current });

  const extraTans = await prisma.salesTdsDeductor.findMany({ where: { clientId: { in: m.clients.map((c) => c.clientId) } }, select: { tan: true, clientId: true } });
  const cards = m.clients.map((c) => {
    const cl = clientById.get(c.clientId);
    const tans = [cl?.billingProfile?.tan, ...extraTans.filter((t) => t.clientId === c.clientId).map((t) => t.tan)].filter((x): x is string => !!x);
    return { clientId: c.clientId, name: cl?.companyName ?? "—", pan: panOf(cl?.billingProfile?.pan ?? null, cl?.billingProfile?.gstin ?? null).pan, tans, billingEmail: cl?.billingProfile?.billingEmail ?? cl?.email ?? null, verdict: c.verdict, quarters: c.quarters };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const deductors = resolved.map((t) => ({ tan: t.tan, name: t.name, kind: t.kind, clientId: t.clientId, clientName: t.clientId ? clientById.get(t.clientId)?.companyName ?? null : null, label: t.label, source: t.source, entries: t.entries, tdsPaise: t.tdsPaise, proposal: t.proposal }));
  const todo: TdsReconView["todo"] = [];
  const unknown = deductors.filter((d) => d.kind === "unknown");
  if (!current) todo.push({ code: "upload", sentence: `Upload Form 26AS for ${fy} to see which clients deposited the TDS they cut from your payments.`, count: 0, paise: null, href: null });
  if (unknown.length) todo.push({ code: "link", sentence: `Say who ${unknown.length} deductor${unknown.length === 1 ? " is" : "s are"}`, count: unknown.length, paise: unknown.reduce((s, d) => s + d.tdsPaise, 0), href: null });
  if (m.totals.chaseCount) todo.push({ code: "chase", sentence: `Chase ${m.totals.chaseCount} item${m.totals.chaseCount === 1 ? "" : "s"} (${reconInr(m.totals.chasePaise)})`, count: m.totals.chaseCount, paise: m.totals.chasePaise, href: null });
  for (const r of m.rows.filter((x) => x.group === "extra")) {
    todo.push({ code: "record", sentence: `Record ${r.clientName ?? r.deductorName}'s ${reconInr(r.form26Paise - r.booksPaise)} TDS — no receipt carries it`, count: 1, paise: r.form26Paise - r.booksPaise, href: r.clientId ? `/payments/record?clientId=${r.clientId}&company=${company}` : null });
  }
  const p = m.rows.filter((x) => x.group === "status_p").length;
  if (p) todo.push({ code: "status_p", sentence: `${p} entr${p === 1 ? "y is" : "ies are"} provisional (P)`, count: p, paise: null, href: null });

  const curFy = financialYear(today).label;
  const fyOptions: string[] = [];
  for (let y = Number(curFy.slice(0, 4)); y >= 2023; y--) fyOptions.push(`${y}-${String((y + 1) % 100).padStart(2, "0")}`);
  return {
    company, fy: { label: fb.label, startDay: fb.startDay, endDay: fb.endDay }, pan: { company: ourPan, file: current?.pan ?? null },
    upload: current ? uploadView(current, current.id, names) : null, history: ups.slice(0, 10).map((u) => uploadView(u, current?.id ?? null, names)), historyCount,
    totals: { ...m.totals, booksByReceiptDatePaise: byReceiptDate }, deductors, clients: cards, rows: m.rows, expectedBy: m.expectedBy, fyOptions, todo,
  };
}
