import { randomBytes } from "crypto";
import { hash as bcryptHash } from "bcrypt";
import { prisma, Prisma } from "@dashmani/db";
import {
  clientBillingProfileSchema, companyScope, sellerProfileSchema, GST_STATE_CODES, importOptionsSchema, rupeesInWords, SALES_COMPANIES, sellerRegistrations, todayIST, findRegistration,
  type CompanyKey, type ImportApplyInput, type ImportClientsInput, type ImportField, type ImportMappingInput, type ImportOptions,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { sha256Hex } from "../../middleware/upload-private";
import { assertMoneyFits, claimManualNumber, dateToDay, dayToDate, inBackground, lockInvoices, logSalesEvent, toSafeNumber, type Tx } from "./common";
import { csvDocument, csvMoney } from "./csv";
import { assertSellerRegistration } from "./documents.service";
import { buyerSnapshotFor, sellerSnapshotFor } from "./invoices.service";
import { recordReceiptTx } from "./payments.service";
import { getSellerOrDefaults, getSellerProfile, sellerFallback, sellerMissingFields, type SellerProfile } from "./settings.service";
import { autoMap, columnSamples, detectHeaderRow, headerSignature, type ImportMapping, type MappingHow } from "./import/fields";
import { buildPlan, extractKeys, PlanLimitError, rowsLabel, type ExistingInvoice, type ImportSummary, type Plan, type PlanContext, type PlanInvoice, type StoredPlan } from "./import/plan";
import { ImportReadError } from "./import/read";
import { readSourceOffThread } from "./import/read-offthread";
import { rs, UNKNOWN_COUNTRY } from "./import/values";

// Old-invoice import from Swipe (spec-import). Upload → check (in the same request) → an Admin
// applies → (maybe) undo. The file is parsed in memory and only its text cells are kept, in
// sales_imports.grid, which no API response ever returns. Every imported invoice is a real tax
// invoice with Swipe's own number, date and stated figures; a paid one gets one SW-<number> receipt.

// ── Limits (env, read at call time so tests can change them) ──────────────────────
const envInt = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const maxRows = () => envInt("SALES_IMPORT_MAX_ROWS", 20_000);
const maxInvoices = () => envInt("SALES_IMPORT_MAX_INVOICES", 5_000);
const staleMin = () => envInt("SALES_IMPORT_STALE_MIN", 2);
export const importsEnabled = () => process.env.SALES_IMPORT_ENABLED !== "0";

/** Every column of sales_imports except the grid (spec-import §3.4: the grid is never returned). */
const importSelect = {
  id: true, companyKey: true, source: true, status: true, fileName: true, fileSha256: true, fileBytes: true, fileKind: true, sheetName: true, sheetNames: true,
  headerRow: true, headerSignature: true, mapping: true, mappingHow: true, options: true, clientChoices: true, createdClients: true, summary: true, planHash: true,
  rowsTotal: true, invoicesFound: true, invoicesReady: true, invoicesImported: true, invoicesSkipped: true, invoicesFailed: true, clientsMatched: true,
  clientsCreated: true, paymentsCreated: true, taxablePaise: true, taxPaise: true, totalPaise: true, paidPaise: true, tdsPaise: true, checkedAt: true,
  applyStartedAt: true, appliedAt: true, appliedById: true, lastError: true, undoneAt: true, undoneById: true, undoReason: true, createdById: true,
  createdAt: true, updatedAt: true,
} as const;
type ImportRow = Prisma.SalesImportGetPayload<{ select: typeof importSelect }>;

type StoredSummary = ImportSummary & { columns?: Array<{ index: number; header: string; samples: string[] }> };

type Db = Tx | typeof prisma;
const otherCompany = (c: CompanyKey): CompanyKey => (c === "dspl" ? "dmpl" : "dspl");
const companyName = (c: CompanyKey, seller: SellerProfile | null) => seller?.legalName || SALES_COMPANIES[c].name;

// ── Test hooks ────────────────────────────────────────────────────────────────────
let invoiceHook: ((n: number) => void | Promise<void>) | null = null;
/** Tests: called before the n-th invoice of a run (0-based); a throw fails the whole run (a crash stand-in). */
export function setImportInvoiceHookForTests(fn: ((n: number) => void | Promise<void>) | null) {
  invoiceHook = fn;
}

let claimHook: (() => void | Promise<void>) | null = null;
/** Tests: called after startApply's first consent check and before its claim (a concurrent edit stand-in). */
export function setImportClaimHookForTests(fn: (() => void | Promise<void>) | null) {
  claimHook = fn;
}

// ── Context for a check (plain reads, no locks: the plan is advisory) ─────────────
/** The company's saved seller profile, read through `db` (a transaction must not reach for another connection). */
async function sellerVia(db: Db, company: CompanyKey): Promise<SellerProfile | null> {
  const row = await db.systemSetting.findUnique({ where: { key: SALES_COMPANIES[company].settingsKey } });
  if (!row) return null;
  try {
    const parsed = sellerProfileSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function loadContext(db: Db, company: CompanyKey, keys: string[], fileName: string, fileSha: string, excludeImportId: string | null, columnsTruncated: boolean): Promise<PlanContext> {
  const seller = await sellerVia(db, company);
  const other = (await sellerVia(db, otherCompany(company))) ?? sellerFallback(otherCompany(company));
  const clientCount = await db.client.count();
  if (clientCount > 20_000) throw new AppError(422, "TOO_MANY_CLIENTS", "There are more than 20,000 clients — the import cannot match against so many");
  const clients = await db.client.findMany({
    select: {
      id: true, companyName: true, createdAt: true,
      billingProfile: { select: { legalName: true, gstin: true, pan: true, stateCode: true, country: true, updatedAt: true } },
      _count: { select: { salesInvoices: true } },
    },
  });
  const upperKeys = keys.map((k) => k.toUpperCase());
  const existing = upperKeys.length
    ? await db.$queryRaw<Array<{ id: string; k: string; company_key: string; client_id: string; issue_date: Date | null; total_paise: number; import_id: string | null; source: string; import_status: string | null; file_name: string | null; import_created_at: Date | null; client_gstin: string | null; client_name: string | null; issued_at: Date | null }>>`
        SELECT i.id, upper(i."number") AS k, i.company_key, i.client_id, i.issue_date, i.total_paise, i.import_id, i.source,
               imp.status AS import_status, imp.file_name, imp.applied_at AS import_created_at, b.gstin AS client_gstin,
               coalesce(b.legal_name, c.company_name) AS client_name, i.issued_at
        FROM sales_invoices i
        LEFT JOIN sales_imports imp ON imp.id = i.import_id
        LEFT JOIN client_billing_profiles b ON b.client_id = i.client_id
        LEFT JOIN clients c ON c.id = i.client_id
        WHERE i."number" IS NOT NULL AND upper(i."number") = ANY(${upperKeys}::text[])`
    : [];
  const seqs = await db.salesSequence.findMany({ where: { key: { startsWith: "invoice" } }, select: { key: true, next: true } });
  const numbers = await db.salesInvoice.findMany({ where: { companyKey: company, kind: "tax_invoice", number: { not: null } }, select: { number: true } });
  const sameFileApplied = await db.salesImport.count({ where: { companyKey: company, fileSha256: fileSha, status: { in: ["applied", "failed", "applying"] }, ...(excludeImportId ? { id: { not: excludeImportId } } : {}) } });
  const otherRegs = sellerRegistrations(other).filter((r) => r.gstin);
  const ctx: PlanContext = {
    company, companyName: companyName(company, seller), today: todayIST(), seller, sellerMissing: sellerMissingFields(seller),
    otherCompany: { name: companyName(otherCompany(company), other), gstins: otherRegs.map((r) => r.gstin!), formats: sellerRegistrations(other).map((r) => ({ prefix: r.invoicePrefix, digits: r.serialDigits })) },
    clients,
    existing: existing.map((e): ExistingInvoice => ({
      id: e.id, k: e.k, companyKey: e.company_key, clientId: e.client_id, issueDate: dateToDay(e.issue_date), totalPaise: e.total_paise, importId: e.import_id, source: e.source,
      importStatus: e.import_status, fileName: e.file_name, importCreatedAt: e.import_created_at ? e.import_created_at.toISOString() : null, clientGstin: e.client_gstin, clientName: e.client_name,
      issuedAt: e.issued_at ? e.issued_at.toISOString() : null,
    })),
    sequences: Object.fromEntries(seqs.map((s) => [s.key, s.next])),
    portalNumbers: numbers.map((n) => n.number!),
    sameFileApplied, columnsTruncated, fileName,
  };
  return ctx;
}

function planOrThrow(input: Parameters<typeof buildPlan>[0], ctx: PlanContext): Plan {
  try {
    return buildPlan(input, ctx, { maxInvoices: maxInvoices() });
  } catch (e) {
    if (e instanceof PlanLimitError) throw new AppError(422, e.code, e.message);
    throw e;
  }
}

function columnsOf(grid: string[][], headerRow: number) {
  const headers = grid[headerRow - 1] ?? [];
  const samples = columnSamples(grid.slice(headerRow), headers.length, 3);
  return headers.map((header, index) => ({ index, header, samples: samples[index] ?? [] }));
}

/** Plan rows → sales_import_invoices rows. */
function planRowData(importId: string, plan: Plan) {
  return plan.rows.map((r) => ({
    importId, invoiceKey: r.key, number: r.number.slice(0, 32), rowNos: r.rowNos as unknown as Prisma.InputJsonValue,
    issueDate: r.issueDate ? dayToDate(r.issueDate) : null, financialYear: r.fy, clientGroup: r.clientGroup.slice(0, 80), sellerGstin: r.sellerGstin,
    outcome: r.outcome, totalPaise: r.totalPaise, paidPaise: r.paidPaise, tdsPaise: r.tdsPaise,
    issues: r.issues as unknown as Prisma.InputJsonValue, plan: r.plan as unknown as Prisma.InputJsonValue,
  }));
}

function counters(plan: Plan) {
  return {
    planHash: plan.planHash, rowsTotal: plan.rowsTotal, invoicesFound: plan.invoicesFound, invoicesReady: plan.invoicesReady,
    invoicesSkipped: plan.rows.filter((r) => r.outcome === "duplicate" || r.outcome === "excluded").length, clientsMatched: plan.clientsMatched, checkedAt: new Date(),
  };
}

// ── Upload ────────────────────────────────────────────────────────────────────────
export interface UploadedFile { buffer: Buffer; originalname: string; size: number }

/** The file name as stored: no path, no control characters, ≤ 255 characters. */
function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload";
  // eslint-disable-next-line no-control-regex
  const out = base.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  return (out || "upload").slice(0, 255);
}

export async function createImport(file: UploadedFile | undefined, body: { company: CompanyKey; registration: string; sheet?: string | null }, actorId: string) {
  if (!file || !file.buffer?.length) throw new AppError(400, "NO_FILE", "Choose the Swipe export (.csv, .xlsx or .xls) to upload");
  const company = body.company;
  if (body.registration && body.registration !== "auto") assertSellerRegistration(await getSellerOrDefaults(company), body.registration, company);
  const fileName = cleanFileName(file.originalname);
  const sha = sha256Hex(file.buffer);
  const limit = maxRows();
  let src: Awaited<ReturnType<typeof readSourceOffThread>>;
  try {
    src = await readSourceOffThread(file.buffer, fileName, body.sheet ?? null, limit);
  } catch (e) {
    if (e instanceof ImportReadError) throw new AppError(422, e.code, e.message);
    throw e;
  }
  const headerIdx = detectHeaderRow(src.rows);
  if (headerIdx === null) {
    throw new AppError(422, "NO_HEADER_ROW", "Couldn't find the column headings in the first 30 rows — the file needs columns such as Invoice Number, Invoice Date and Customer Name");
  }
  const bodyRows = src.rows.length - headerIdx - 1;
  if (bodyRows <= 0) throw new AppError(422, "EMPTY_FILE", "This file has no rows");
  if (bodyRows > limit) throw new AppError(422, "TOO_MANY_ROWS", `This file has more than ${limit.toLocaleString("en-IN")} rows — the limit is ${limit.toLocaleString("en-IN")}. Export one financial year at a time.`);
  const headerRow = headerIdx + 1;
  const headers = src.rows[headerIdx];
  const signature = headerSignature(headers);

  // A later upload with the same columns starts from the last applied import's mapping.
  const previous = await prisma.salesImport.findFirst({
    where: { companyKey: company, headerSignature: signature, status: "applied" }, orderBy: { appliedAt: "desc" }, select: { mapping: true },
  });
  let mapping: ImportMapping;
  let how: Partial<Record<ImportField, MappingHow>>;
  if (previous) {
    mapping = previous.mapping as ImportMapping;
    how = Object.fromEntries(Object.entries(mapping).map(([f, c]) => [f, c === null || c === undefined ? "missing" : "previous"])) as Partial<Record<ImportField, MappingHow>>;
  } else {
    const [seller, other] = await Promise.all([getSellerOrDefaults(company), getSellerOrDefaults(otherCompany(company))]);
    const own = new Set([...sellerRegistrations(seller), ...sellerRegistrations(other)].map((r) => r.gstin?.toUpperCase()).filter((g): g is string => !!g));
    const m = autoMap(headers, src.rows.slice(headerRow), own);
    mapping = m.mapping;
    how = m.how;
  }
  const options: ImportOptions = importOptionsSchema.parse({ registration: body.registration ?? "auto" });
  const input = { grid: src.rows, headerRow, mapping, options, clientChoices: {} as Record<string, string> };
  const ctx = await loadContext(prisma, company, extractKeys(input), fileName, sha, null, src.columnsTruncated);
  const plan = planOrThrow(input, ctx);
  const summary: StoredSummary = { ...plan.summary, columns: columnsOf(src.rows, headerRow) };

  const id = await prisma.$transaction(async (tx) => {
    const row = await tx.salesImport.create({
      data: {
        companyKey: company, fileName, fileSha256: sha, fileBytes: file.size || file.buffer.length, fileKind: src.kind, sheetName: src.sheet,
        sheetNames: src.sheetNames as unknown as Prisma.InputJsonValue, headerRow, headerSignature: signature,
        grid: src.rows as unknown as Prisma.InputJsonValue, mapping: mapping as Prisma.InputJsonValue, mappingHow: how as Prisma.InputJsonValue,
        options: options as unknown as Prisma.InputJsonValue, clientChoices: {}, createdClients: {}, summary: summary as unknown as Prisma.InputJsonValue,
        createdById: actorId, ...counters(plan),
      },
      select: { id: true },
    });
    const data = planRowData(row.id, plan);
    for (let i = 0; i < data.length; i += 1000) await tx.salesImportInvoice.createMany({ data: data.slice(i, i + 1000) });
    await logSalesEvent(tx, { entityType: "import", entityId: row.id, actorId, action: "uploaded", note: `${fileName} · ${plan.invoicesFound} invoices, ${plan.invoicesReady} ready` });
    return row.id;
  }, { timeout: 60_000, maxWait: 10_000 });
  return getImport(id);
}

// ── Re-check (columns, clients, "check again") ────────────────────────────────────
async function recheck(id: string, actorId: string, note: string, change: (cur: { mapping: ImportMapping; mappingHow: Partial<Record<ImportField, MappingHow>>; options: ImportOptions; headerRow: number; clientChoices: Record<string, string>; companyKey: CompanyKey }) => { mapping?: ImportMapping; mappingHow?: Partial<Record<ImportField, MappingHow>>; options?: ImportOptions; headerRow?: number; clientChoices?: Record<string, string> }) {
  // Read the grid once, outside the lock (it never changes after upload).
  const base = await prisma.salesImport.findUnique({ where: { id }, select: { id: true, grid: true, fileName: true, fileSha256: true, companyKey: true, status: true, summary: true } });
  if (!base) throw new AppError(404, "NOT_FOUND", "Import not found");
  if (base.status !== "draft") throw new AppError(409, "IMPORT_NOT_DRAFT", "This import has already run — upload the file again to check it with other columns");
  const grid = base.grid as unknown as string[][];
  const company = base.companyKey as CompanyKey;
  await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM sales_imports WHERE id = ${id} FOR UPDATE`;
    if (!lock) throw new AppError(404, "NOT_FOUND", "Import not found");
    if (lock.status !== "draft") throw new AppError(409, "IMPORT_NOT_DRAFT", "This import has already run — upload the file again to check it with other columns");
    const cur = await tx.salesImport.findUniqueOrThrow({ where: { id }, select: { mapping: true, mappingHow: true, options: true, headerRow: true, clientChoices: true } });
    const state = {
      mapping: cur.mapping as ImportMapping, mappingHow: (cur.mappingHow ?? {}) as Partial<Record<ImportField, MappingHow>>, options: importOptionsSchema.parse(cur.options ?? {}), headerRow: cur.headerRow,
      clientChoices: (cur.clientChoices ?? {}) as Record<string, string>, companyKey: company,
    };
    const next = change(state);
    const mapping = next.mapping ?? state.mapping;
    const options = next.options ?? state.options;
    const headerRow = next.headerRow ?? state.headerRow;
    const clientChoices = next.clientChoices ?? state.clientChoices;
    if (headerRow > grid.length) throw new AppError(400, "VALIDATION_ERROR", `The file has only ${grid.length} rows`);
    const input = { grid, headerRow, mapping, options, clientChoices };
    const prevSummary = base.summary as unknown as StoredSummary | null;
    const ctx = await loadContext(tx, company, extractKeys(input), base.fileName, base.fileSha256, id, !!prevSummary?.notices?.some((n) => n.code === "COLUMNS_TRUNCATED"));
    const plan = planOrThrow(input, ctx);
    const summary: StoredSummary = { ...plan.summary, columns: columnsOf(grid, headerRow) };
    await tx.salesImportInvoice.deleteMany({ where: { importId: id } });
    const data = planRowData(id, plan);
    for (let i = 0; i < data.length; i += 1000) await tx.salesImportInvoice.createMany({ data: data.slice(i, i + 1000) });
    await tx.salesImport.update({
      where: { id },
      data: {
        mapping: mapping as Prisma.InputJsonValue, ...(next.mappingHow ? { mappingHow: next.mappingHow as Prisma.InputJsonValue } : {}),
        options: options as unknown as Prisma.InputJsonValue, headerRow, clientChoices: clientChoices as Prisma.InputJsonValue,
        summary: summary as unknown as Prisma.InputJsonValue, ...counters(plan),
      },
    });
    await logSalesEvent(tx, { entityType: "import", entityId: id, actorId, action: "checked", note: `${note} · ${plan.invoicesFound} invoices, ${plan.invoicesReady} ready` });
  }, { timeout: 60_000, maxWait: 10_000 });
}

export async function saveMapping(id: string, body: ImportMappingInput, actorId: string) {
  const imp = await prisma.salesImport.findUnique({ where: { id }, select: { companyKey: true } });
  if (!imp) throw new AppError(404, "NOT_FOUND", "Import not found");
  const company = imp.companyKey as CompanyKey;
  if (body.options.registration !== "auto") assertSellerRegistration(await getSellerOrDefaults(company), body.options.registration, company);
  await recheck(id, actorId, "columns", (cur) => {
    // A field the person did not change keeps its badge (auto / check / previous); a changed one is "user".
    const mapping: ImportMapping = { ...cur.mapping };
    const how: Partial<Record<ImportField, MappingHow>> = { ...cur.mappingHow };
    for (const [f, c] of Object.entries(body.mapping) as Array<[ImportField, number | null]>) {
      const before = cur.mapping[f] ?? null;
      mapping[f] = c;
      if ((c ?? null) !== before) how[f] = c === null || c === undefined ? "missing" : "user";
    }
    return { mapping, mappingHow: how, options: body.options, ...(body.headerRow ? { headerRow: body.headerRow } : {}) };
  });
  return getImport(id);
}

export async function saveClientChoices(id: string, body: ImportClientsInput, actorId: string) {
  const ids = body.choices.map((c) => c.clientId).filter((c) => c !== "new" && c !== "auto");
  if (ids.length) {
    const found = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.filter((x) => !found.some((f) => f.id === x));
    if (missing.length) throw new AppError(400, "VALIDATION_ERROR", "A chosen client does not exist");
  }
  await recheck(id, actorId, "clients", (cur) => {
    const choices = { ...cur.clientChoices };
    for (const c of body.choices) {
      if (c.clientId === "auto") delete choices[c.groupKey];
      else choices[c.groupKey] = c.clientId;
    }
    return { clientChoices: choices };
  });
  return getImport(id);
}

export async function runCheck(id: string, actorId: string) {
  await recheck(id, actorId, "check again", () => ({}));
  return getImport(id);
}

// ── Apply ─────────────────────────────────────────────────────────────────────────
/** `updated_at` is the heartbeat (every per-invoice transaction bumps it). Raw SQL writes it as UTC, like Prisma. */
const isStale = (imp: { status: string; updatedAt: Date }) => imp.status === "applying" && Date.now() - imp.updatedAt.getTime() > staleMin() * 60_000;
const running = new Set<string>();

/**
 * The Admin's consent to THIS plan (§3.6 step 2, §4.15): the hash they looked at, the warnings they
 * ticked, the live-series move they confirmed — read through `db` (inside the claim, under the lock).
 * Returns how many invoices are left to import.
 */
async function assertConsent(db: Db, id: string, body: ImportApplyInput, resume: boolean): Promise<number> {
  const imp = await db.salesImport.findUniqueOrThrow({ where: { id }, select: { planHash: true, summary: true, invoicesReady: true } });
  const summary = imp.summary as unknown as StoredSummary | null;
  if (!resume && summary?.blockers?.length) throw new AppError(409, "IMPORT_BLOCKED", summary.blockers[0].message);
  const remaining = await db.salesImportInvoice.count({ where: { importId: id, outcome: { in: ["ready", "warning"] } } });
  if (!remaining) throw new AppError(409, "NOTHING_TO_IMPORT", "No invoices are ready to import — every invoice is already in the portal, left out or has an error");
  if (body.planHash !== imp.planHash) {
    const total = summary?.toImport?.totalPaise ?? 0;
    throw new AppError(409, "PLAN_CHANGED", `Something changed since you looked at this check — it now finds ${imp.invoicesReady.toLocaleString("en-IN")} invoices worth ${rs(total)}. Look at it again, then import`);
  }
  const warnings = summary?.outcomes?.warning ?? 0;
  if (warnings > 0 && !body.acceptWarnings) throw new AppError(409, "WARNINGS_NOT_ACCEPTED", `Tick “I have read the ${warnings.toLocaleString("en-IN")} warning${warnings === 1 ? "" : "s"}” before importing`);
  const live = summary?.liveSeriesMoves ?? [];
  if (live.length && !body.confirmLiveSeries) {
    const m = live[0];
    throw new AppError(409, "LIVE_SERIES_NOT_CONFIRMED", `This import moves the live series ${m.label} from ${m.from} to ${m.to} — confirm it before importing`);
  }
  return remaining;
}

export async function startApply(id: string, body: ImportApplyInput, actorId: string) {
  const imp = await prisma.salesImport.findUnique({ where: { id }, select: importSelect });
  if (!imp) throw new AppError(404, "NOT_FOUND", "Import not found");
  const company = imp.companyKey as CompanyKey;
  if (imp.status === "applied" || imp.status === "undone") throw new AppError(409, "IMPORT_NOT_DRAFT", "This import has already run — upload the file again to check it with other columns");
  if (imp.status === "applying" && !isStale(imp)) throw new AppError(409, "IMPORT_BUSY", "This import is running — wait for it to finish");
  const resume = imp.status === "failed" || imp.status === "applying";
  if (!resume) {
    // A fresh check against live portal state; its plan rows are what apply will create.
    try {
      await recheck(id, actorId, "before import", () => ({}));
    } catch (e) {
      if (e instanceof AppError && e.code === "IMPORT_NOT_DRAFT") throw new AppError(409, "IMPORT_BUSY", "This import is running — wait for it to finish");
      throw e;
    }
  }
  const seller = await getSellerProfile(company);
  if (sellerMissingFields(seller).length) throw new AppError(422, "SELLER_PROFILE_INCOMPLETE", `Complete ${companyName(company, seller)}'s GST profile in Settings before importing invoices`);
  const remaining = await assertConsent(prisma, id, body, resume);
  if (claimHook) await claimHook();

  // Claim: one import per company at a time. The consent is checked again under the row lock: a
  // mapping / clients / "check again" request that committed since the check above rewrote the plan
  // rows and plan_hash, and the run must never import a plan the Admin did not see (§4.15).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sales-import:" + company}))`;
    await tx.$queryRaw`SELECT id FROM sales_imports WHERE id = ${id} FOR UPDATE`;
    await assertConsent(tx, id, body, resume);
    const stale = staleMin();
    const busy = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM sales_imports WHERE company_key = ${company} AND status = 'applying' AND id <> ${id}
        AND updated_at >= (now() AT TIME ZONE 'UTC') - make_interval(mins => ${stale}::int) LIMIT 1`;
    if (busy.length) throw new AppError(409, "IMPORT_BUSY", `Another import into ${companyName(company, seller)} is running — wait for it to finish`);
    const n = await tx.$executeRaw`
      UPDATE sales_imports SET status = 'applying', apply_started_at = (now() AT TIME ZONE 'UTC'), applied_by_id = ${actorId}, last_error = NULL, updated_at = (now() AT TIME ZONE 'UTC')
      WHERE id = ${id} AND plan_hash = ${body.planHash}
        AND (status IN ('draft', 'failed') OR (status = 'applying' AND updated_at < (now() AT TIME ZONE 'UTC') - make_interval(mins => ${stale}::int)))`;
    if (n === 0) throw new AppError(409, "IMPORT_BUSY", "This import is running — wait for it to finish");
    await logSalesEvent(tx, { entityType: "import", entityId: id, actorId, action: "apply_started", note: resume ? "resumed" : `${remaining} invoices` });
  });
  inBackground(`swipe import ${id}`, () => runApply(id, actorId));
  return getImport(id);
}

class StopRun extends Error {}

const clientSelect = {
  id: true, companyName: true, contactName: true, email: true, phone: true,
  billingProfile: { select: { legalName: true, gstin: true, pan: true, addressLine1: true, addressLine2: true, city: true, state: true, stateCode: true, pincode: true, country: true, billingEmail: true } },
} as const;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "client";

/** A billing profile from the file's customer details, or null when it would not validate. */
function profileFromFile(inv: PlanInvoice, fileName: string, importId: string) {
  const g = inv.client.gstin;
  const abroad = inv.placeOfSupplyCode === "EXPORT";
  const stateCode = abroad ? null : g ? g.slice(0, 2) : inv.customer.stateCode;
  if (!g && !inv.customer.address) return { ok: false as const, reason: "nothing" };
  const email = inv.customer.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inv.customer.email) ? inv.customer.email : null;
  const parsed = clientBillingProfileSchema.safeParse({
    legalName: inv.client.name.slice(0, 200), gstin: g, pan: g ? g.slice(2, 12) : null,
    stateCode, state: stateCode ? GST_STATE_CODES[stateCode] ?? null : null,
    addressLine1: inv.customer.address?.slice(0, 200) ?? null, city: inv.customer.city?.slice(0, 100) ?? null, pincode: inv.customer.pincode?.slice(0, 10) ?? null,
    billingEmail: email, country: abroad ? inv.customer.country ?? UNKNOWN_COUNTRY : "IN", notes: `Created by Swipe import ${fileName} (${importId.slice(0, 8)})`,
  });
  return parsed.success ? { ok: true as const, data: parsed.data } : { ok: false as const, reason: "invalid" };
}

async function applyClients(importId: string, actorId: string, fileName: string, opts: ImportOptions) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_imports WHERE id = ${importId} FOR UPDATE`;
    const imp = await tx.salesImport.findUniqueOrThrow({ where: { id: importId }, select: { createdClients: true, clientsCreated: true } });
    const created = { ...((imp.createdClients ?? {}) as Record<string, string>) };
    const rows = await tx.salesImportInvoice.findMany({ where: { importId, outcome: { in: ["ready", "warning"] } }, select: { plan: true }, orderBy: [{ issueDate: "asc" }, { number: "asc" }] });
    const firstOf = new Map<string, PlanInvoice>();
    for (const r of rows) {
      const inv = (r.plan as unknown as StoredPlan | null)?.invoice;
      if (inv && !firstOf.has(inv.client.groupKey)) firstOf.set(inv.client.groupKey, inv);
    }
    let passwordHash: string | null = null;
    let newClients = 0;
    for (const [groupKey, inv] of firstOf) {
      if (inv.client.clientId) {
        if (!opts.fillMissingProfiles) continue;
        const has = await tx.clientBillingProfile.findUnique({ where: { clientId: inv.client.clientId }, select: { id: true } });
        if (has) continue; // an existing profile is never changed
        const p = profileFromFile(inv, fileName, importId);
        if (!p.ok) continue;
        await tx.clientBillingProfile.create({ data: { ...p.data, clientId: inv.client.clientId } });
        await logSalesEvent(tx, { entityType: "client", entityId: inv.client.clientId, actorId, action: "billing_profile_imported", note: `Swipe import ${fileName}` });
        continue;
      }
      if (created[groupKey]) continue; // resume never creates twice
      passwordHash ??= await bcryptHash(randomBytes(32).toString("hex"), 12);
      const name = inv.client.name.slice(0, 200) || "Swipe customer";
      // A failed INSERT aborts the whole interactive transaction in Postgres, so a P2002 can't be retried
      // here: pick an address that is free first (12 random hex digits — a clash is all but impossible).
      let email = "";
      for (let attempt = 0; attempt < 5 && !email; attempt++) {
        const candidate = `${slug(name)}-${randomBytes(6).toString("hex")}@imported.invalid`;
        if (!(await tx.client.findFirst({ where: { email: { equals: candidate, mode: "insensitive" } }, select: { id: true } }))) email = candidate;
      }
      if (!email) throw new AppError(409, "CLIENT_EMAIL_TAKEN", `Couldn't create a client for ${name} — resume the import`);
      const { id: clientId } = await tx.client.create({
        data: { companyName: name, contactName: name.slice(0, 120), email, passwordHash, status: "ACTIVE" },
        select: { id: true },
      });
      const p = profileFromFile(inv, fileName, importId);
      if (p.ok) await tx.clientBillingProfile.create({ data: { ...p.data, clientId } });
      created[groupKey] = clientId;
      newClients++;
      await logSalesEvent(tx, { entityType: "client", entityId: clientId, actorId, action: "client_imported", note: `Swipe import ${fileName}${p.ok ? "" : " (no billing profile — the file's details did not validate)"}` });
    }
    await tx.salesImport.update({ where: { id: importId }, data: { createdClients: created, clientsCreated: imp.clientsCreated + newClients } });
  }, { timeout: 60_000, maxWait: 10_000 });
}

const noonIst = (day: string) => new Date(`${day}T06:30:00.000Z`);

async function applyOne(importId: string, planRowId: string, company: CompanyKey, seller: SellerProfile, fileName: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const [imp] = await tx.$queryRaw<Array<{ status: string; created_clients: Record<string, string> }>>`SELECT status, created_clients FROM sales_imports WHERE id = ${importId} FOR UPDATE`;
    if (imp?.status !== "applying") throw new StopRun();
    const row = await tx.salesImportInvoice.findUnique({ where: { id: planRowId } });
    if (!row || !["ready", "warning"].includes(row.outcome)) return;
    const p = (row.plan as unknown as StoredPlan).invoice;
    if (!p) throw new AppError(422, "NO_PLAN", "This invoice has no plan — check the import again");
    const mark = async (outcome: "imported" | "failed", error: string | null, invoiceId: string | null) => {
      await tx.salesImportInvoice.update({ where: { id: row.id }, data: { outcome, error, invoiceId } });
      if (outcome === "failed") await tx.$executeRaw`UPDATE sales_imports SET invoices_failed = invoices_failed + 1, updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ${importId}`;
      else await tx.$executeRaw`UPDATE sales_imports SET invoices_imported = invoices_imported + 1, updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ${importId}`;
    };
    // Number guard: the same number anywhere in the portal (case-insensitive).
    const hit = await tx.salesInvoice.findFirst({ where: { number: { equals: p.number, mode: "insensitive" } }, select: { id: true, importId: true } });
    if (hit) {
      if (hit.importId === importId) await mark("imported", null, hit.id);
      else await mark("failed", "NUMBER_TAKEN: already in the portal", null);
      return;
    }
    const reg = findRegistration(seller, p.registration.gstin);
    if (!reg) { await mark("failed", "REGISTRATION_GONE: the seller profile no longer holds this GSTIN", null); return; }
    if (p.registration.claimSeries) await claimManualNumber(tx, "invoice", reg.invoicePrefix, p.issueDate, companyScope(company, reg.scope), p.number, reg.serialDigits);
    const clientId = p.client.clientId ?? imp.created_clients?.[p.client.groupKey];
    if (!clientId) throw new AppError(422, "CLIENT_MISSING", `No client for ${p.client.name} — check the import again`);
    const client = await tx.client.findUnique({ where: { id: clientId }, select: clientSelect });
    if (!client) throw new AppError(422, "CLIENT_MISSING", `The client for ${p.client.name} no longer exists — check the import again`);
    const buyer = buyerSnapshotFor(client as Parameters<typeof buyerSnapshotFor>[0]);
    if (p.client.gstin) {
      const sc = p.client.gstin.slice(0, 2);
      Object.assign(buyer, { gstin: p.client.gstin, stateCode: sc, state: GST_STATE_CODES[sc] ?? buyer.state, pan: buyer.pan ?? p.client.gstin.slice(2, 12) });
    } else {
      Object.assign(buyer, { gstin: null });
    }
    // A buyer abroad (place of supply "Other countries"): Accounts files it under exports only when the
    // snapshot's country is not India — the plan decided which (UNKNOWN_COUNTRY when nothing names it).
    if (p.placeOfSupplyCode === "EXPORT") Object.assign(buyer, { country: p.customer.country ?? UNKNOWN_COUNTRY, stateCode: null, state: null });
    const t = p.totals;
    assertMoneyFits({ subtotalPaise: t.subtotalPaise, taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, totalPaise: t.totalPaise });
    const cancelled = p.docStatus === "cancelled";
    const inv = await tx.salesInvoice.create({
      data: {
        companyKey: company, kind: "tax_invoice", clientId, number: p.number, source: "swipe", importId,
        status: p.docStatus, issueDate: dayToDate(p.issueDate), dueDate: dayToDate(p.dueDate),
        placeOfSupplyCode: p.placeOfSupplyCode === "EXPORT" ? null : p.placeOfSupplyCode, taxMode: p.taxMode, gstRateBp: p.gstRateBp, sellerGstin: reg.gstin,
        subtotalPaise: t.subtotalPaise, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise,
        roundOffPaise: t.roundOffPaise, totalPaise: t.totalPaise,
        sellerSnapshot: sellerSnapshotFor(seller, reg) as Prisma.InputJsonValue, buyerSnapshot: buyer as Prisma.InputJsonValue, amountInWords: rupeesInWords(t.totalPaise),
        poNumber: p.poNumber?.slice(0, 50) ?? null, poDate: p.poDate ? dayToDate(p.poDate) : null, notes: p.notes, terms: null,
        internalNotes: `Imported from Swipe (${fileName}, rows ${rowsLabel(p.rowNos)}) · Swipe status: ${p.swipeStatus ?? "—"}${p.irn ? ` · IRN ${p.irn}` : ""}`,
        issuedAt: noonIst(p.issueDate), sentAt: noonIst(p.issueDate), createdAt: noonIst(p.issueDate),
        paidAt: p.payment ? noonIst(p.payment.paidOn) : null,
        cancelledAt: cancelled ? noonIst(p.issueDate) : null, cancelReason: cancelled ? "Cancelled in Swipe" : null,
        createdById: actorId,
        items: { create: p.lines.map((l, i) => ({ position: i, description: l.description, sac: l.sac, quantity: l.quantity, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise, amountPaise: l.amountPaise })) },
      },
      select: { id: true },
    });
    await logSalesEvent(tx, { entityType: "invoice", entityId: inv.id, actorId, action: "imported", toStatus: p.docStatus, note: `Swipe import · ${fileName} · rows ${rowsLabel(p.rowNos)}` });
    let paymentId: string | null = null;
    if (p.payment && !cancelled) {
      const r = await recordReceiptTx(tx, {
        companyKey: company, clientId, amountPaise: p.payment.cashPaise, tdsPaise: p.payment.tdsPaise,
        mode: "bank_transfer", reference: "Swipe import", paidOn: p.payment.paidOn, bankName: null,
        notes: `Imported from Swipe (${fileName}, import ${importId.slice(0, 8)}) — amount as recorded in Swipe; the bank date may differ${p.payment.tdsNote ? ` · ${p.payment.tdsNote}` : ""}`,
        allocations: [{ invoiceId: inv.id, amountPaise: p.payment.cashPaise, tdsPaise: p.payment.tdsPaise }],
      } as Parameters<typeof recordReceiptTx>[1], actorId, { number: p.payment.number, imported: true, columns: { importId } });
      paymentId = r.id;
    }
    await tx.salesImportInvoice.update({ where: { id: row.id }, data: { outcome: "imported", invoiceId: inv.id, paymentId, error: null } });
    const tax = t.cgstPaise + t.sgstPaise + t.igstPaise;
    const cash = !cancelled && p.payment ? p.payment.cashPaise : 0;
    const tds = !cancelled && p.payment ? p.payment.tdsPaise : 0;
    await tx.$executeRaw`UPDATE sales_imports SET invoices_imported = invoices_imported + 1, payments_created = payments_created + ${paymentId ? 1 : 0},
      taxable_paise = taxable_paise + ${cancelled ? 0 : t.taxablePaise}::bigint, tax_paise = tax_paise + ${cancelled ? 0 : tax}::bigint,
      total_paise = total_paise + ${cancelled ? 0 : t.totalPaise}::bigint, paid_paise = paid_paise + ${cash}::bigint, tds_paise = tds_paise + ${tds}::bigint,
      updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ${importId}`;
  }, { timeout: 15_000, maxWait: 10_000 });
}

const RUN_STOPPED = "The import stopped because of a server error — resume it to finish (nothing is created twice)";
/** Connection-level Prisma failures: the database, not this invoice — stop the run, Resume retries. */
const INFRA_CODES = new Set(["P2024", "P2028", "P2034"]);

/** A short tag for the server log: the error's class and code, never its message. */
function errorTag(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return `${e.name} ${e.code}`;
  if (e instanceof Error) return e.name;
  return typeof e;
}

/**
 * The sentence stored on a plan row when ONE invoice could not be created, or null when the error is
 * not about that invoice (the whole run stops; Resume carries on). A bad value in one row — an
 * overflowing figure, a broken reference — must fail that row, not every Resume after it.
 */
function perInvoiceFailure(e: unknown): string | null {
  if (e instanceof AppError) return `${e.code}: ${e.message}`.slice(0, 500);
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code.startsWith("P1") || INFRA_CODES.has(e.code)) return null;
    if (e.code === "P2002") return "NUMBER_TAKEN: the number was used in the portal meanwhile";
    return `SERVER_ERROR: this invoice could not be saved (${e.code}) — check its figures in the file`;
  }
  if (e instanceof Prisma.PrismaClientValidationError || e instanceof Prisma.PrismaClientUnknownRequestError) {
    return "SERVER_ERROR: this invoice could not be saved — check its figures in the file";
  }
  return null;
}

/** The background run (never call directly from a route — startApply claims the row first). */
export async function runApply(id: string, actorId: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const imp = await prisma.salesImport.findUnique({ where: { id }, select: { companyKey: true, fileName: true, options: true, status: true } });
    if (!imp || imp.status !== "applying") return;
    const company = imp.companyKey as CompanyKey;
    const seller = await getSellerProfile(company);
    if (!seller || sellerMissingFields(seller).length) throw new AppError(422, "SELLER_PROFILE_INCOMPLETE", `${companyName(company, seller)}'s GST profile is incomplete — complete it in Settings, then resume`);
    await applyClients(id, actorId, imp.fileName, importOptionsSchema.parse(imp.options ?? {}));
    const todo = await prisma.salesImportInvoice.findMany({ where: { importId: id, outcome: { in: ["ready", "warning"] } }, orderBy: [{ issueDate: "asc" }, { number: "asc" }], select: { id: true } });
    let n = 0;
    for (const r of todo) {
      if (invoiceHook) await invoiceHook(n);
      n++;
      try {
        await applyOne(id, r.id, company, seller, imp.fileName, actorId);
      } catch (e) {
        if (e instanceof StopRun) return;
        const msg = perInvoiceFailure(e);
        if (msg === null) throw e;
        if (!(e instanceof AppError)) console.error(`[sales-import] run ${id}: invoice row ${r.id} failed (${errorTag(e)})`);
        await prisma.salesImportInvoice.update({ where: { id: r.id }, data: { outcome: "failed", error: msg } });
        await prisma.$executeRaw`UPDATE sales_imports SET invoices_failed = invoices_failed + 1, updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ${id}`;
      }
    }
    await finishApply(id, actorId);
  } catch (e) {
    // Only our own sentences reach the portal and the event feed; a Prisma message carries server
    // paths and the create() arguments (buyer GSTIN, address), so it stays a code in the log.
    const msg = (e instanceof AppError ? e.message : RUN_STOPPED).slice(0, 500);
    console.error(`[sales-import] run ${id} failed (${errorTag(e)})`);
    await prisma.salesImport.updateMany({ where: { id, status: "applying" }, data: { status: "failed", lastError: msg } }).catch(() => undefined);
    await logSalesEvent(prisma, { entityType: "import", entityId: id, actorId, action: "apply_failed", note: msg }).catch(() => undefined);
  } finally {
    running.delete(id);
  }
}

async function finishApply(id: string, actorId: string) {
  const rec = await reconcileImport(id);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_imports WHERE id = ${id} FOR UPDATE`;
    const imp = await tx.salesImport.findUniqueOrThrow({ where: { id }, select: { status: true, summary: true, invoicesImported: true, paymentsCreated: true, clientsCreated: true, invoicesFailed: true } });
    if (imp.status !== "applying") return;
    const summary = { ...((imp.summary ?? {}) as unknown as StoredSummary), reconcile: rec };
    if (!rec.ok) summary.notices = [...(summary.notices ?? []), { code: "RECONCILE_MISMATCH", level: "warning", message: "The imported totals differ from the check for at least one financial year — see Imported vs file" }];
    await tx.salesImport.update({ where: { id }, data: { status: "applied", appliedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue } });
    const note = `${imp.invoicesImported} invoices, ${imp.paymentsCreated} receipts, ${imp.clientsCreated} new clients${imp.invoicesFailed ? `; ${imp.invoicesFailed} failed` : ""}${rec.ok ? "" : "; RECONCILE_MISMATCH"}`;
    await logSalesEvent(tx, { entityType: "import", entityId: id, actorId, action: "applied", note });
  });
}

/** §4.13: what landed per financial year (from sales_invoices) against the plan rows marked imported. */
export async function reconcileImport(id: string) {
  const landed = await prisma.$queryRaw<Array<{ fy_start: number; invoices: number; taxable_paise: bigint; tax_paise: bigint; total_paise: bigint }>>`
    SELECT CASE WHEN EXTRACT(MONTH FROM i.issue_date) >= 4 THEN EXTRACT(YEAR FROM i.issue_date)::int ELSE EXTRACT(YEAR FROM i.issue_date)::int - 1 END AS fy_start,
           count(*)::int AS invoices,
           COALESCE(sum(i.taxable_paise) FILTER (WHERE i.status <> 'cancelled'), 0)::bigint AS taxable_paise,
           COALESCE(sum(i.cgst_paise + i.sgst_paise + i.igst_paise) FILTER (WHERE i.status <> 'cancelled'), 0)::bigint AS tax_paise,
           COALESCE(sum(i.total_paise) FILTER (WHERE i.status <> 'cancelled'), 0)::bigint AS total_paise
    FROM sales_invoices i WHERE i.import_id = ${id} GROUP BY 1 ORDER BY 1`;
  const planned = await prisma.salesImportInvoice.findMany({ where: { importId: id, outcome: "imported" }, select: { plan: true } });
  const plan = new Map<string, { invoices: number; total: number; taxable: number; tax: number }>();
  for (const r of planned) {
    const inv = (r.plan as unknown as StoredPlan | null)?.invoice;
    if (!inv) continue;
    const e = plan.get(inv.fy) ?? { invoices: 0, total: 0, taxable: 0, tax: 0 };
    e.invoices++;
    if (inv.docStatus !== "cancelled") { e.total += inv.totals.totalPaise; e.taxable += inv.totals.taxablePaise; e.tax += inv.totals.cgstPaise + inv.totals.sgstPaise + inv.totals.igstPaise; }
    plan.set(inv.fy, e);
  }
  const fyLabel = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const byFy = landed.map((l) => {
    const fy = fyLabel(l.fy_start);
    const p = plan.get(fy);
    return { fy, invoices: l.invoices, taxablePaise: toSafeNumber(l.taxable_paise), taxPaise: toSafeNumber(l.tax_paise), totalPaise: toSafeNumber(l.total_paise), planTotalPaise: p?.total ?? 0, ok: !!p && p.invoices === l.invoices && p.total === toSafeNumber(l.total_paise) && p.taxable === toSafeNumber(l.taxable_paise) && p.tax === toSafeNumber(l.tax_paise) };
  });
  for (const fy of plan.keys()) if (!byFy.some((b) => b.fy === fy)) byFy.push({ fy, invoices: 0, taxablePaise: 0, taxPaise: 0, totalPaise: 0, planTotalPaise: plan.get(fy)!.total, ok: false });
  byFy.sort((a, b) => a.fy.localeCompare(b.fy));
  return { ok: byFy.every((b) => b.ok), byFy: byFy.map(({ ok: _ok, ...b }) => b) };
}

/** Re-run reconciliation for an applied import and store it (tests / a manual re-check). */
export async function rerunReconcile(id: string) {
  const rec = await reconcileImport(id);
  const imp = await prisma.salesImport.findUniqueOrThrow({ where: { id }, select: { summary: true } });
  const summary = { ...((imp.summary ?? {}) as unknown as StoredSummary), reconcile: rec };
  summary.notices = (summary.notices ?? []).filter((n) => n.code !== "RECONCILE_MISMATCH");
  if (!rec.ok) summary.notices.push({ code: "RECONCILE_MISMATCH", level: "warning", message: "The imported totals differ from the check for at least one financial year — see Imported vs file" });
  await prisma.salesImport.update({ where: { id }, data: { summary: summary as unknown as Prisma.InputJsonValue } });
  return rec;
}

// ── Undo ──────────────────────────────────────────────────────────────────────────

/** §4.12 step 4: what still points at the import's documents. Empty = undo would succeed. */
async function undoBlockers(db: Db, importId: string): Promise<{ messages: string[]; more: number }> {
  const out: string[] = [];
  let total = 0;
  const take = async <T>(rows: T[], count: number, fmt: (r: T) => string) => {
    total += count;
    for (const r of rows) if (out.length < 3) out.push(fmt(r));
  };
  const a = await db.$queryRaw<Array<{ inv: string | null; pay: string; n: number }>>`
    SELECT i."number" AS inv, p."number" AS pay, count(*) OVER ()::int AS n FROM sales_payment_allocations a
      JOIN sales_invoices i ON i.id = a.invoice_id JOIN sales_payments p ON p.id = a.payment_id
    WHERE i.import_id = ${importId} AND p.import_id IS DISTINCT FROM ${importId} ORDER BY i."number" LIMIT 5`;
  await take(a, a[0]?.n ?? 0, (r) => `${r.inv} has receipt ${r.pay} recorded in the portal`);
  const b = await db.$queryRaw<Array<{ inv: string | null; cn: string; n: number }>>`
    SELECT i."number" AS inv, c."number" AS cn, count(*) OVER ()::int AS n FROM sales_credit_notes c JOIN sales_invoices i ON i.id = c.invoice_id
    WHERE i.import_id = ${importId} ORDER BY i."number" LIMIT 5`;
  await take(b, b[0]?.n ?? 0, (r) => `${r.inv} has credit note ${r.cn}`);
  const c = await db.$queryRaw<Array<{ inv: string | null; n: number }>>`
    SELECT i."number" AS inv, count(*) OVER ()::int AS n FROM sales_einvoices e JOIN sales_invoices i ON i.id = e.invoice_id
    WHERE i.import_id = ${importId} ORDER BY i."number" LIMIT 5`;
  await take(c, c[0]?.n ?? 0, (r) => `${r.inv} has an e-invoice record`);
  const d1 = await db.$queryRaw<Array<{ pay: string; n: number }>>`
    SELECT p."number" AS pay, count(*) OVER ()::int AS n FROM sales_refunds r JOIN sales_payments p ON p.id = r.payment_id
    WHERE p.import_id = ${importId} ORDER BY p."number" LIMIT 5`;
  await take(d1, d1[0]?.n ?? 0, (r) => `${r.pay} has a refund`);
  const d2 = await db.$queryRaw<Array<{ pay: string; inv: string | null; n: number }>>`
    SELECT p."number" AS pay, i."number" AS inv, count(*) OVER ()::int AS n FROM sales_payment_allocations a
      JOIN sales_payments p ON p.id = a.payment_id JOIN sales_invoices i ON i.id = a.invoice_id
    WHERE p.import_id = ${importId} AND i.import_id IS DISTINCT FROM ${importId} ORDER BY p."number" LIMIT 5`;
  await take(d2, d2[0]?.n ?? 0, (r) => `${r.pay} is applied to ${r.inv}, which this import did not create`);
  // (e) spec-00 §6.2: a document Tally holds can never be deleted here. The table arrives with the Tally PR.
  const [{ t }] = await db.$queryRaw<Array<{ t: string | null }>>`SELECT to_regclass('public.sales_tally_items')::text AS t`;
  if (t) {
    const e = await db.$queryRaw<Array<{ doc: string; n: number }>>`
      SELECT ti.doc_number AS doc, count(*) OVER ()::int AS n FROM sales_tally_items ti
      WHERE ti.outcome IN ('pending', 'sending', 'synced', 'adopted', 'unknown')
        AND ti.doc_id IN (SELECT id FROM sales_invoices WHERE import_id = ${importId} UNION ALL SELECT id FROM sales_payments WHERE import_id = ${importId})
      ORDER BY ti.doc_number LIMIT 5`;
    await take(e, e[0]?.n ?? 0, (r) => `${r.doc} is already in Tally — cancel it there before undoing`);
  }
  // (f) a receipt matched to a bank line — added by the bank PR (spec-00 §6.3).
  return { messages: out, more: Math.max(0, total - out.length) };
}

function blockedSentence(b: { messages: string[]; more: number }) {
  return `Can't undo: ${b.messages.join("; ")}${b.more ? ` (and ${b.more} more)` : ""}. Undo is only for imports nothing else has touched`;
}

export async function undoState(importId: string): Promise<{ allowed: boolean; blockedBy: string | null }> {
  const b = await undoBlockers(prisma, importId);
  return b.messages.length ? { allowed: false, blockedBy: blockedSentence(b) } : { allowed: true, blockedBy: null };
}

export async function undoImport(id: string, reason: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const [imp] = await tx.$queryRaw<Array<{ status: string; clients_created: number }>>`SELECT status, clients_created FROM sales_imports WHERE id = ${id} FOR UPDATE`;
    if (!imp) throw new AppError(404, "NOT_FOUND", "Import not found");
    if (imp.status !== "applied" && imp.status !== "failed") throw new AppError(409, "IMPORT_NOT_APPLIED", "Only an applied import can be undone");
    const pays = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_payments WHERE import_id = ${id} ORDER BY id FOR UPDATE`;
    const invs = await tx.salesInvoice.findMany({ where: { importId: id }, select: { id: true, number: true }, orderBy: { id: "asc" } });
    for (let i = 0; i < invs.length; i += 1000) await lockInvoices(tx, invs.slice(i, i + 1000).map((x) => x.id));
    const b = await undoBlockers(tx, id);
    if (b.messages.length) throw new AppError(409, "UNDO_BLOCKED", blockedSentence(b));
    const payNumbers = await tx.salesPayment.findMany({ where: { importId: id }, select: { id: true, number: true } });
    await tx.salesPayment.deleteMany({ where: { importId: id } });
    await tx.salesInvoice.deleteMany({ where: { importId: id } });
    await tx.salesImport.update({ where: { id }, data: { status: "undone", undoneAt: new Date(), undoneById: actorId, undoReason: reason } });
    const events = [
      ...invs.map((x) => ({ entityType: "invoice", entityId: x.id, actorId, action: "import_undone", note: x.number })),
      ...payNumbers.map((x) => ({ entityType: "payment", entityId: x.id, actorId, action: "import_undone", note: x.number })),
    ];
    for (let i = 0; i < events.length; i += 1000) await tx.salesEvent.createMany({ data: events.slice(i, i + 1000) });
    await logSalesEvent(tx, { entityType: "import", entityId: id, actorId, action: "undone", note: `${invs.length} invoices and ${pays.length} receipts removed; ${imp.clients_created} clients it created are kept; invoice series unchanged — ${reason}`.slice(0, 1000) });
  }, { timeout: 60_000, maxWait: 10_000 });
  return getImport(id);
}

export async function discardImport(id: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const [imp] = await tx.$queryRaw<Array<{ status: string; file_name: string }>>`SELECT status, file_name FROM sales_imports WHERE id = ${id} FOR UPDATE`;
    if (!imp) throw new AppError(404, "NOT_FOUND", "Import not found");
    if (imp.status !== "draft") throw new AppError(409, "IMPORT_NOT_DRAFT", "This import has already run — upload the file again to check it with other columns");
    await tx.salesImport.delete({ where: { id } });
    await logSalesEvent(tx, { entityType: "import", entityId: id, actorId, action: "discarded", note: imp.file_name });
  });
  return { deleted: true };
}

// ── Reads ─────────────────────────────────────────────────────────────────────────
async function namesOf(ids: Array<string | null>): Promise<Map<string, string>> {
  const real = [...new Set(ids.filter((x): x is string => !!x && x !== "system"))];
  if (!real.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: real } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function listRow(r: ImportRow, names: Map<string, string>) {
  return {
    id: r.id, companyKey: r.companyKey as CompanyKey, status: r.status, fileName: r.fileName, createdAt: r.createdAt.toISOString(), createdByName: names.get(r.createdById) ?? null,
    counts: { rows: r.rowsTotal, found: r.invoicesFound, ready: r.invoicesReady, imported: r.invoicesImported, skipped: r.invoicesSkipped, failed: r.invoicesFailed, clientsMatched: r.clientsMatched, clientsCreated: r.clientsCreated, payments: r.paymentsCreated },
    totalPaise: toSafeNumber(r.totalPaise),
    appliedAt: r.appliedAt?.toISOString() ?? null, undoneAt: r.undoneAt?.toISOString() ?? null,
    undo: r.status === "applied" || r.status === "failed" ? await undoState(r.id) : null,
  };
}

export async function listImports(f: { companyKey?: CompanyKey }) {
  const rows = await prisma.salesImport.findMany({ where: f.companyKey ? { companyKey: f.companyKey } : {}, orderBy: { createdAt: "desc" }, take: 100, select: importSelect });
  const names = await namesOf(rows.map((r) => r.createdById));
  const out = [];
  for (const r of rows) out.push(await listRow(r, names));
  return out;
}

export async function getImport(id: string) {
  const r = await prisma.salesImport.findUnique({ where: { id }, select: importSelect });
  if (!r) throw new AppError(404, "NOT_FOUND", "Import not found");
  const names = await namesOf([r.createdById, r.appliedById, r.undoneById]);
  const stored = (r.summary ?? null) as unknown as StoredSummary | null;
  const { columns, ...summary } = stored ?? ({} as StoredSummary);
  const sameFile = await prisma.salesImport.findMany({ where: { companyKey: r.companyKey, fileSha256: r.fileSha256, id: { not: r.id } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, createdAt: true } });
  return {
    ...(await listRow(r, names)),
    source: "swipe" as const,
    stale: isStale(r),
    file: { sha256: r.fileSha256, bytes: r.fileBytes, kind: r.fileKind as "csv" | "xlsx" | "xls", sheet: r.sheetName, sheets: (r.sheetNames ?? []) as string[], headerRow: r.headerRow },
    columns: columns ?? [],
    mapping: r.mapping as ImportMapping,
    mappingHow: r.mappingHow as Partial<Record<ImportField, MappingHow>>,
    options: importOptionsSchema.parse(r.options ?? {}),
    summary: stored ? (summary as ImportSummary) : null,
    planHash: r.planHash,
    landed: { taxablePaise: toSafeNumber(r.taxablePaise), taxPaise: toSafeNumber(r.taxPaise), totalPaise: toSafeNumber(r.totalPaise), paidPaise: toSafeNumber(r.paidPaise), tdsPaise: toSafeNumber(r.tdsPaise) },
    checkedAt: r.checkedAt?.toISOString() ?? null,
    appliedByName: r.appliedById ? names.get(r.appliedById) ?? null : null,
    undoneByName: r.undoneById ? names.get(r.undoneById) ?? null : null,
    undoReason: r.undoReason,
    sameFile: sameFile.map((s) => ({ id: s.id, status: s.status, createdAt: s.createdAt.toISOString() })),
    lastError: r.lastError,
  };
}

/** Plan rows whose customer name (as written in Swipe) contains `q`, any case. */
async function customerMatches(importId: string, q: string): Promise<string[]> {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sales_import_invoices WHERE import_id = ${importId} AND plan -> 'view' -> 'customer' ->> 'name' ILIKE ${like} LIMIT 5000`;
  return rows.map((r) => r.id);
}

const OUTCOMES = new Set(["ready", "warning", "error", "excluded", "duplicate", "imported", "failed"]);

export async function listImportInvoices(id: string, f: { outcome?: string; q?: string; from?: number; limit?: number }) {
  const exists = await prisma.salesImport.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new AppError(404, "NOT_FOUND", "Import not found");
  const outcome = f.outcome === "attention" ? "error" : f.outcome && f.outcome !== "all" ? f.outcome : undefined;
  if (outcome && !OUTCOMES.has(outcome)) throw new AppError(400, "BAD_QUERY", "Unknown outcome");
  const q = f.q?.trim();
  const where: Prisma.SalesImportInvoiceWhereInput = {
    importId: id,
    ...(outcome ? { outcome } : {}),
    ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { clientGroup: { contains: q, mode: "insensitive" } }, { id: { in: await customerMatches(id, q) } }] } : {}),
  };
  const take = Math.min(200, Math.max(1, f.limit ?? 100));
  const skip = Math.max(0, f.from ?? 0);
  const [total, rows] = await Promise.all([
    prisma.salesImportInvoice.count({ where }),
    prisma.salesImportInvoice.findMany({ where, orderBy: [{ issueDate: "asc" }, { number: "asc" }], skip, take }),
  ]);
  return { total, rows: rows.map(invoiceRowView) };
}

function invoiceRowView(r: Prisma.SalesImportInvoiceGetPayload<object>) {
  const plan = r.plan as unknown as StoredPlan | null;
  const v = plan?.view;
  return {
    key: r.invoiceKey, number: r.number, rowNos: r.rowNos as number[], issueDate: dateToDay(r.issueDate), fy: r.financialYear,
    customer: v?.customer ?? { name: "", gstin: null, groupKey: r.clientGroup, clientId: null, clientName: null, decision: "choose" as const },
    registration: v?.registration ?? null, docStatus: v?.docStatus ?? null, swipeStatus: v?.swipeStatus ?? null,
    taxMode: v?.taxMode ?? null, gstRateBp: v?.gstRateBp ?? null,
    taxablePaise: v?.taxablePaise ?? null, cgstPaise: v?.cgstPaise ?? null, sgstPaise: v?.sgstPaise ?? null, igstPaise: v?.igstPaise ?? null,
    roundOffPaise: v?.roundOffPaise ?? null, totalPaise: v?.totalPaise ?? r.totalPaise,
    paidPaise: r.paidPaise, tdsPaise: r.tdsPaise, outcome: r.outcome, issues: r.issues,
    invoiceId: r.invoiceId, paymentId: r.paymentId, error: r.error,
  };
}

// ── Report CSV (§4.14) ────────────────────────────────────────────────────────────
export async function importReportCsv(id: string): Promise<{ body: Buffer; filename: string }> {
  const imp = await prisma.salesImport.findUnique({ where: { id }, select: { id: true, createdAt: true, taxablePaise: true, taxPaise: true, totalPaise: true, paidPaise: true, tdsPaise: true } });
  if (!imp) throw new AppError(404, "NOT_FOUND", "Import not found");
  const rows = await prisma.salesImportInvoice.findMany({ where: { importId: id }, orderBy: [{ issueDate: "asc" }, { number: "asc" }] });
  const money = (v: number | null | undefined) => (v === null || v === undefined ? "" : csvMoney(v));
  const out: unknown[][] = [[
    "Invoice number", "Rows", "Date", "FY", "Customer", "Customer GSTIN", "Client", "Billed from GSTIN", "GST type", "GST rate %", "Taxable", "CGST", "SGST", "IGST",
    "Round off", "Total", "Paid", "TDS", "Outcome", "Issues", "Portal invoice id", "Receipt",
  ]];
  for (const r of rows) {
    const v = invoiceRowView(r);
    out.push([
      v.number, rowsLabel(v.rowNos), v.issueDate ?? "", v.fy ?? "", v.customer.name, v.customer.gstin ?? "", v.customer.clientName ?? (v.customer.decision === "new" ? "(new client)" : ""),
      v.registration?.gstin ?? "", v.taxMode ?? "", v.gstRateBp === null ? "" : (v.gstRateBp / 100).toFixed(2),
      money(v.taxablePaise), money(v.cgstPaise), money(v.sgstPaise), money(v.igstPaise), money(v.roundOffPaise), money(v.totalPaise), money(v.paidPaise), money(v.tdsPaise),
      v.outcome, ((v.issues ?? []) as Array<{ message: string }>).map((i) => i.message).join(" | "), v.invoiceId ?? "", r.paymentId ? `SW-${v.number}` : "",
    ]);
  }
  // What landed (BIGINT sums — can exceed INT), not the plan.
  out.push(["Imports totals", "", "", "", "", "", "", "", "", "", csvMoney(imp.taxablePaise), "", "", "", "", csvMoney(imp.totalPaise), csvMoney(imp.paidPaise), csvMoney(imp.tdsPaise), "", `GST ${csvMoney(imp.taxPaise)}`, "", ""]);
  return { body: csvDocument(out), filename: `swipe-import-${todayIST()}-${id.slice(0, 8)}.csv` };
}
