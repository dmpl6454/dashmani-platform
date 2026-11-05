import { randomUUID } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import {
  describeFiledEdit,
  FILED_FIGURE_KEYS,
  fyBounds,
  SALES_COMPANIES,
  type CompanyKey,
  type EntryUnit,
  type FiledFigureKey,
  type FiledYearInput,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { logSalesEvent, toSafeNumber, type Tx } from "./common";

// Filed accounts (spec-accounts §2, §3.6): the 12 key figures an admin types from a company's
// signed balance sheet + P&L for a CLOSED financial year, and up to 5 signed PDFs per year.
// ⚠️ PDF bytes live in finance_filed_files.data (BYTEA) — never on disk, never under uploads/.
// Every query here SELECTS AROUND `data`; only getFiledFile reads it. Never `include` files.

export const FILED_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILED_FILES_PER_YEAR = 5;

const FILE_SELECT = { id: true, kind: true, fileName: true, sizeBytes: true, sha256: true, createdAt: true } as const;

export const FILED_SELECT = {
  id: true,
  companyKey: true,
  financialYear: true,
  revenuePaise: true,
  otherIncomePaise: true,
  totalExpensesPaise: true,
  profitBeforeTaxPaise: true,
  taxExpensePaise: true,
  profitAfterTaxPaise: true,
  totalAssetsPaise: true,
  totalLiabilitiesPaise: true,
  equityPaise: true,
  cashAndBankPaise: true,
  tradeReceivablesPaise: true,
  tradePayablesPaise: true,
  enteredIn: true,
  notes: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  files: { select: FILE_SELECT, orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.FinanceFiledYearSelect;

type FiledRow = Prisma.FinanceFiledYearGetPayload<{ select: typeof FILED_SELECT }>;

export interface FiledFileView { id: string; kind: string; fileName: string; sizeBytes: number; sha256: string; createdAt: string }
export interface FiledYearView {
  id: string;
  fy: string;
  enteredIn: EntryUnit;
  notes: string | null;
  updatedAt: string;
  updatedById: string;
  figures: Record<FiledFigureKey, number | null>;
  files: FiledFileView[];
}

const big = (v: bigint | null): number | null => (v == null ? null : toSafeNumber(v, "filed figure"));

export function filedView(r: FiledRow): FiledYearView {
  const figures = {} as Record<FiledFigureKey, number | null>;
  for (const k of FILED_FIGURE_KEYS) figures[k] = big(r[k]);
  return {
    id: r.id,
    fy: r.financialYear,
    enteredIn: r.enteredIn as EntryUnit,
    notes: r.notes,
    updatedAt: r.updatedAt.toISOString(),
    updatedById: r.updatedById,
    figures,
    files: r.files.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
  };
}

export async function listFiledYears(company: CompanyKey): Promise<FiledYearView[]> {
  const rows = await prisma.financeFiledYear.findMany({ where: { companyKey: company }, select: FILED_SELECT, orderBy: { financialYear: "desc" } });
  return rows.map(filedView);
}

const fyEndLabel = (fy: string) => {
  const b = fyBounds(fy)!;
  return `31 March ${b.endDay.slice(0, 4)}`;
};

/** Routes 5 and 6 only work on a year that has ended. */
export function assertFyClosed(fy: string, today: string): void {
  const b = fyBounds(fy);
  if (!b || b.endDay >= today) {
    throw new AppError(422, "FY_NOT_CLOSED", `${fy} is still running — filed accounts can be added after it closes on ${fyEndLabel(fy)}.`);
  }
}

const changedError = (fy: string) => new AppError(409, "FILED_CHANGED", `Someone else saved ${fy} a moment ago — reload to see their figures before saving yours.`);

async function lockYear(tx: Tx, company: CompanyKey, fy: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM finance_filed_years WHERE company_key = ${company} AND financial_year = ${fy} FOR UPDATE`;
  return rows[0]?.id ?? null;
}

/**
 * PUT = full replace of the 12 figures, the unit and the notes. Optimistic concurrency on
 * `baseUpdatedAt` (the updatedAt the form loaded, null when it started from no row). Nothing
 * changed → no write, no event, `changed: false`.
 */
export async function saveFiledYear(company: CompanyKey, fy: string, input: FiledYearInput, actorId: string): Promise<{ filed: FiledYearView; changed: boolean }> {
  const notes = input.notes && input.notes.trim() ? input.notes.trim() : null;
  const figures = {} as Record<FiledFigureKey, number | null>;
  for (const k of FILED_FIGURE_KEYS) figures[k] = input[k] ?? null;
  const after = { figures, enteredIn: input.enteredIn as EntryUnit, notes };
  const data: Record<string, unknown> = { enteredIn: after.enteredIn, notes, updatedById: actorId };
  for (const k of FILED_FIGURE_KEYS) data[k] = figures[k] == null ? null : BigInt(figures[k]!);

  try {
    return await prisma.$transaction(async (tx) => {
      const id = await lockYear(tx, company, fy);
      if (!id) {
        if (input.baseUpdatedAt !== null) throw changedError(fy);
        const row = await tx.financeFiledYear.create({
          data: { ...(data as object), companyKey: company, financialYear: fy, createdById: actorId } as Prisma.FinanceFiledYearUncheckedCreateInput,
          select: FILED_SELECT,
        });
        await logSalesEvent(tx, { entityType: "filed_year", entityId: row.id, actorId, action: "filed_figures_saved", note: describeFiledEdit(null, after) || "Saved" });
        return { filed: filedView(row), changed: true };
      }
      const current = await tx.financeFiledYear.findUniqueOrThrow({ where: { id }, select: FILED_SELECT });
      if (input.baseUpdatedAt !== current.updatedAt.toISOString()) throw changedError(fy);
      const beforeView = filedView(current);
      const before = { figures: beforeView.figures, enteredIn: beforeView.enteredIn, notes: beforeView.notes };
      const note = describeFiledEdit(before, after);
      if (!note) return { filed: beforeView, changed: false };
      const row = await tx.financeFiledYear.update({ where: { id }, data: data as Prisma.FinanceFiledYearUncheckedUpdateInput, select: FILED_SELECT });
      await logSalesEvent(tx, { entityType: "filed_year", entityId: id, actorId, action: "filed_figures_saved", note });
      return { filed: filedView(row), changed: true };
    });
  } catch (err) {
    // Two first saves at once: the loser's create hits the unique (company, FY) key.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw changedError(fy);
    throw err;
  }
}

export const FILE_KIND_LABELS: Record<string, string> = { accounts: "Signed accounts", audit_report: "Auditor's report", other: "Other" };

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const fileNote = (f: { kind: string; fileName: string; sizeBytes: number; sha256: string }) =>
  `${FILE_KIND_LABELS[f.kind] ?? f.kind} · ${f.fileName} · ${sizeLabel(f.sizeBytes)} · sha256 ${f.sha256.slice(0, 4)}…${f.sha256.slice(-4)}`;

/** The first attach creates the year row. The same bytes twice are one row (duplicate: true). */
export async function addFiledFile(
  company: CompanyKey,
  fy: string,
  file: { kind: string; name: string; bytes: Buffer; sha256: string },
  actorId: string,
): Promise<{ file: FiledFileView; duplicate: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO finance_filed_years (id, company_key, financial_year, entered_in, created_by_id, updated_by_id, updated_at)
      VALUES (${randomUUID()}, ${company}, ${fy}, 'rupees', ${actorId}, ${actorId}, now()) ON CONFLICT (company_key, financial_year) DO NOTHING`;
    const yearId = (await lockYear(tx, company, fy))!;
    const existing = await tx.financeFiledFile.findUnique({ where: { filedYearId_sha256: { filedYearId: yearId, sha256: file.sha256 } }, select: FILE_SELECT });
    if (existing) return { file: { ...existing, createdAt: existing.createdAt.toISOString() }, duplicate: true };
    const count = await tx.financeFiledFile.count({ where: { filedYearId: yearId } });
    if (count >= FILED_FILES_PER_YEAR) {
      throw new AppError(409, "TOO_MANY_FILES", `${fy} already has ${FILED_FILES_PER_YEAR} PDFs — remove one before attaching another.`);
    }
    const row = await tx.financeFiledFile.create({
      data: { filedYearId: yearId, kind: file.kind, fileName: file.name, sizeBytes: file.bytes.length, sha256: file.sha256, data: file.bytes, uploadedById: actorId },
      select: FILE_SELECT,
    });
    await logSalesEvent(tx, { entityType: "filed_year", entityId: yearId, actorId, action: "filed_document_added", note: fileNote(row) });
    return { file: { ...row, createdAt: row.createdAt.toISOString() }, duplicate: false };
  }, { timeout: 30_000 });
}

const fileGone = () => new AppError(404, "NOT_FOUND", "That PDF is no longer attached.");

/** The ONE query that reads the bytes. */
export async function getFiledFile(fileId: string): Promise<{ fileName: string; data: Buffer }> {
  const row = await prisma.financeFiledFile.findUnique({ where: { id: fileId }, select: { fileName: true, data: true } });
  if (!row) throw fileGone();
  return { fileName: row.fileName, data: Buffer.from(row.data) };
}

export async function removeFiledFile(fileId: string, actorId: string): Promise<{ removed: true }> {
  return prisma.$transaction(async (tx) => {
    const f = await tx.financeFiledFile.findUnique({ where: { id: fileId }, select: { ...FILE_SELECT, filedYearId: true } });
    if (!f) throw fileGone();
    await tx.$queryRaw`SELECT id FROM finance_filed_years WHERE id = ${f.filedYearId} FOR UPDATE`;
    const gone = await tx.financeFiledFile.deleteMany({ where: { id: fileId } });
    if (gone.count === 0) throw fileGone();
    await logSalesEvent(tx, { entityType: "filed_year", entityId: f.filedYearId, actorId, action: "filed_document_removed", note: fileNote(f) });
    return { removed: true as const };
  });
}

export const companyName = (c: CompanyKey) => SALES_COMPANIES[c].short;
