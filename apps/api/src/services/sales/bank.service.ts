import { createHash } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import {
  BANK_DEFAULT_MATCH_FROM, BANK_IGNORE_LABELS, BANK_PRESET_LABELS, MAX_PAISE, SALES_COMPANIES, TDS_RATES,
  bankInr, bankMappingSchema, bankPct, last4, nearestRate, netTaxable, paymentCreateSchema, tdsAt, todayIST,
  type BankAccountCreateInput, type BankAccountUpdateInput, type BankIgnoreBeforeInput, type BankLineConfirmInput,
  type BankLineIgnoreInput, type BankLineUnlinkInput, type BankMapping, type BankPreset, type BankStatementImportInput,
  type BankStatementUploadInput, type CompanyKey,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { sha256Hex } from "../../middleware/upload-private";
import { dateToDay, dayToDate, logSalesEvent, toSafeNumber, type Tx } from "./common";
import { applyMapping, dedupeHashes, detectMapping, headerSignature, readGrid, type Cell, type Need, type ParsedLine, type StatementFormat } from "./bank-parse";
import { fingerprintTokens, matchCredits, matchDebits, shortDay, type ClientInfo, type MatchContext, type MatchLine, type MatchResult, type OpenInvoice, type UnlinkedReceipt } from "./bank-match";
import { getPayment, lockPayment, recordReceiptTx, voidPaymentInTx } from "./payments.service";
import { queueInvoiceEmails, SYSTEM_ACTOR } from "./invoice-email.service";
import { getSellerOrDefaults } from "./settings.service";

// Bank statement upload, matching and TDS (spec-bank.md; spec-00 wins where they differ).
//
// Rules that keep the books right — do not loosen any of them:
//  • The statement file is read in memory and never stored (sha256 + name + size + mapping only).
//  • Bank money is BIGINT paise; it leaves this file as numbers through toSafeNumber().
//  • No receipt is ever created without a person clicking (one line, or Confirm all sure ≤ 25).
//    The only automatic action links a credit to a receipt staff already recorded — no money moves.
//  • Lock order: bank line → receipt → invoices → sequence. voidPayment keeps its own transaction
//    and refreshes the line after commit (refreshBankLineAfterVoid).
//  • refreshBankLine is the single writer of a line's status and matched_paise (the bulk
//    "ignore everything before <date>" writes the same values refreshBankLine would).
//  • Withdrawal narrations are for sales:approve only (redacted here, not in the portal).

const DAY_MS = 86_400_000;
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
const n = (v: bigint | number | null | undefined, what = "amount") => toSafeNumber(v, what);
const OPEN_STATUSES = ["unmatched", "suggested", "partly_matched"];

// ── Accounts ─────────────────────────────────────────────────────────────────────

type AccountRow = Prisma.SalesBankAccountGetPayload<object>;
function accountView(a: AccountRow, lastStatementTo: Date | null = null) {
  return {
    id: a.id, companyKey: a.companyKey as CompanyKey, label: a.label, bank: a.bank as BankPreset, accountNumber: a.accountNumber,
    last4: last4(a.accountNumber), ifsc: a.ifsc, matchFrom: dateToDay(a.matchFrom), status: a.status as "active" | "archived",
    lastStatementTo: dateToDay(lastStatementTo), createdAt: a.createdAt,
  };
}
const accountName = (a: { label: string; accountNumber: string }) => `${a.label} ••${last4(a.accountNumber)}`;

export async function listBankAccounts(company?: CompanyKey) {
  const rows = await prisma.salesBankAccount.findMany({ where: company ? { companyKey: company } : {}, orderBy: [{ status: "asc" }, { label: "asc" }] });
  const last = rows.length
    ? await prisma.salesBankStatement.groupBy({ by: ["bankAccountId"], where: { bankAccountId: { in: rows.map((r) => r.id) } }, _max: { periodTo: true } })
    : [];
  return rows.map((r) => accountView(r, last.find((l) => l.bankAccountId === r.id)?._max.periodTo ?? null));
}

export async function createBankAccount(input: BankAccountCreateInput, actorId: string) {
  const taken = await prisma.salesBankAccount.findUnique({ where: { accountNumber: input.accountNumber } });
  if (taken) throw new AppError(409, "ACCOUNT_TAKEN", `That account number is already set up (for ${SALES_COMPANIES[taken.companyKey as CompanyKey]?.short ?? taken.companyKey})`);
  // Owner (2026-11-05): credits are matched from FY 2023-24 unless the admin picks another day.
  const matchFrom = input.matchFrom === undefined ? BANK_DEFAULT_MATCH_FROM : input.matchFrom;
  try {
    const a = await prisma.salesBankAccount.create({
      data: {
        companyKey: input.companyKey, label: input.label, bank: input.bank, accountNumber: input.accountNumber,
        ifsc: input.ifsc ?? null, matchFrom: matchFrom ? dayToDate(matchFrom) : null, createdById: actorId,
      },
    });
    await logSalesEvent(prisma, { entityType: "bank_account", entityId: a.id, actorId, action: "created", note: `${accountName(a)} · ${BANK_PRESET_LABELS[a.bank]} · matching from ${matchFrom ?? "the first statement"}` });
    return accountView(a);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new AppError(409, "ACCOUNT_TAKEN", "That account number is already set up");
    throw err;
  }
}

export async function updateBankAccount(id: string, input: BankAccountUpdateInput, actorId: string) {
  const before = await prisma.salesBankAccount.findUnique({ where: { id } });
  if (!before) throw new AppError(404, "NOT_FOUND", "Bank account not found");
  const data: Prisma.SalesBankAccountUpdateInput = {};
  const changed: string[] = [];
  if (input.label !== undefined && input.label !== before.label) { data.label = input.label; changed.push("label"); }
  if (input.ifsc !== undefined && (input.ifsc ?? null) !== before.ifsc) { data.ifsc = input.ifsc ?? null; changed.push("IFSC"); }
  if (input.matchFrom !== undefined && (input.matchFrom ?? null) !== dateToDay(before.matchFrom)) {
    data.matchFrom = input.matchFrom ? dayToDate(input.matchFrom) : null;
    changed.push(`match from ${input.matchFrom ?? "(none)"}`);
  }
  if (input.status !== undefined && input.status !== before.status) { data.status = input.status; changed.push(input.status); }
  if (!changed.length) return accountView(before);
  const a = await prisma.salesBankAccount.update({ where: { id }, data });
  await logSalesEvent(prisma, { entityType: "bank_account", entityId: id, actorId, action: input.status === "archived" && before.status !== "archived" ? "archived" : "updated", note: changed.join(", ") });
  return accountView(a);
}

// ── Statements: preview and import ─────────────────────────────────────────────────

/** One statement is parsed at a time (2 GB box; parsing is synchronous CPU work). */
let parsing = false;
type UploadedFile = { buffer: Buffer; originalname: string; size: number };

interface StatementRead {
  account: AccountRow; sha: string; format: StatementFormat; sheets: string[]; sheet: string | null; rows: Cell[][];
  mapping: BankMapping | null; mappingSource: "given" | "last_used" | "detected" | null; preset: BankPreset | null; needs: Need[];
  report: ReturnType<typeof applyMapping> | null; hashes: string[]; isNew: boolean[]; possibleDuplicate: boolean[];
  duplicateOf: { statementId: string; fileName: string; createdAt: Date } | null;
  blockers: string[]; warnings: string[]; beforeCutover: number;
}

async function readStatement(file: UploadedFile | undefined, body: BankStatementUploadInput, company: CompanyKey, mode: "preview" | "import"): Promise<StatementRead> {
  if (!file) throw new AppError(400, "NO_FILE", "Choose the statement file to upload");
  const account = await prisma.salesBankAccount.findUnique({ where: { id: body.bankAccountId } });
  if (!account) throw new AppError(404, "NOT_FOUND", "Bank account not found");
  if (account.companyKey !== company) throw new AppError(409, "COMPANY_MISMATCH", `${accountName(account)} belongs to ${SALES_COMPANIES[account.companyKey as CompanyKey]?.short ?? account.companyKey} — switch company at the top first`);
  if (account.status === "archived") throw new AppError(409, "ACCOUNT_ARCHIVED", `${accountName(account)} is archived — statements can no longer be added to it`);
  if (parsing) throw new AppError(429, "BANK_BUSY", "Another statement is being read — try again in a few seconds");
  parsing = true;
  try {
    const sha = sha256Hex(file.buffer);
    if (mode === "import" && body.expectedSha256 !== sha) throw new AppError(409, "FILE_CHANGED", "The file is not the one that was checked — check it again");
    let given: BankMapping | null = null;
    if (body.mapping) {
      let raw: unknown;
      try { raw = JSON.parse(body.mapping); } catch { throw new AppError(400, "BAD_MAPPING", "The column choice could not be read — choose the columns again"); }
      const p = bankMappingSchema.safeParse(raw);
      if (!p.success) throw new AppError(400, "BAD_MAPPING", "The column choice could not be read — choose the columns again");
      given = p.data;
    }
    const grid = readGrid(file.buffer, file.originalname, given?.sheet ?? null);
    const rows = grid.rows;
    let mapping: BankMapping | null = null;
    let mappingSource: StatementRead["mappingSource"] = null;
    let preset: BankPreset | null = (account.bank as BankPreset) ?? null;
    let needs: Need[] = [];
    const warnings: string[] = [];
    if (given) {
      mapping = { ...given, sheet: grid.sheet };
      mappingSource = "given";
    } else {
      // The layout used last time on this account, when this file's headings are the same.
      const prior = await prisma.salesBankStatement.findMany({ where: { bankAccountId: account.id }, orderBy: { createdAt: "desc" }, take: 5, select: { mapping: true, preset: true } });
      for (const p of prior) {
        const m = p.mapping as (BankMapping & { headerSignature?: string }) | null;
        if (!m?.headerSignature || !rows[m.headerRow - 1]) continue;
        if (headerSignature(rows[m.headerRow - 1]) === m.headerSignature) {
          const { headerSignature: _sig, ...rest } = m;
          mapping = { ...(rest as BankMapping), sheet: grid.sheet };
          mappingSource = "last_used";
          preset = (p.preset as BankPreset | null) ?? preset;
          break;
        }
      }
      if (!mapping) {
        const d = detectMapping(rows, account.bank as BankPreset);
        if (d) {
          mapping = { ...d.mapping, sheet: grid.sheet };
          mappingSource = "detected";
          preset = d.preset;
          needs = d.needs;
          warnings.push(...d.warnings);
        } else needs = ["columns"];
      }
    }

    const blockers: string[] = [];
    let report: StatementRead["report"] = null;
    let hashes: string[] = [];
    let isNew: boolean[] = [];
    let possibleDuplicate: boolean[] = [];
    let beforeCutover = 0;
    const matchFrom = dateToDay(account.matchFrom);
    if (mapping) {
      report = applyMapping(rows, mapping, { today: todayIST(), accountNumber: account.accountNumber, matchFrom });
      hashes = dedupeHashes(account.id, report.lines);
      const existing = new Set<string>();
      for (let i = 0; i < hashes.length; i += 5000) {
        const chunk = hashes.slice(i, i + 5000);
        const found = await prisma.$queryRaw<Array<{ dedupe_hash: string }>>`SELECT dedupe_hash FROM sales_bank_lines WHERE bank_account_id = ${account.id} AND dedupe_hash = ANY(${chunk}::text[])`;
        for (const f of found) existing.add(f.dedupe_hash);
      }
      isNew = hashes.map((h) => !existing.has(h));
      // The possible-duplicate net (§4.2): same account, same day and amounts, a balance/UTR that
      // does not contradict, but a different hash (another download format of the same month).
      possibleDuplicate = report.lines.map(() => false);
      if (report.period && isNew.some(Boolean)) {
        const old = await prisma.salesBankLine.findMany({
          where: { bankAccountId: account.id, txnDate: { gte: dayToDate(report.period.from), lte: dayToDate(report.period.to) } },
          select: { txnDate: true, creditPaise: true, debitPaise: true, balancePaise: true, utr: true, dedupeHash: true },
        });
        const byKey = new Map<string, typeof old>();
        for (const o of old) {
          const k = `${dateToDay(o.txnDate)}|${o.creditPaise}|${o.debitPaise}`;
          byKey.set(k, [...(byKey.get(k) ?? []), o]);
        }
        report.lines.forEach((l, i) => {
          if (!isNew[i]) return;
          possibleDuplicate[i] = (byKey.get(`${l.txnDate}|${l.creditPaise}|${l.debitPaise}`) ?? []).some((o) =>
            o.dedupeHash !== hashes[i] && (o.balancePaise === null || l.balancePaise === null || o.balancePaise === l.balancePaise || (!!o.utr && o.utr === l.utr)));
        });
      }
      beforeCutover = matchFrom ? report.lines.filter((l, i) => isNew[i] && l.creditPaise > 0n && l.txnDate < matchFrom).length : 0;
    }
    const dup = await prisma.salesBankStatement.findUnique({ where: { bankAccountId_fileSha256: { bankAccountId: account.id, fileSha256: sha } }, select: { id: true, fileName: true, createdAt: true } });
    const duplicateOf = dup ? { statementId: dup.id, fileName: dup.fileName, createdAt: dup.createdAt } : null;

    // Blockers (no import) and warnings (import needs "import anyway").
    if (needs.includes("columns")) blockers.push("The column headings could not be found — choose the columns below");
    if (needs.includes("dateFormat")) blockers.push("The dates could be day/month or month/day — choose which below");
    if (needs.includes("amountSign")) blockers.push("This file has one signed Amount column — choose whether a positive amount is a deposit or a withdrawal");
    if (duplicateOf) blockers.push(`This exact file was already imported on ${shortDay(dateToDay(duplicateOf.createdAt)!)} (${duplicateOf.fileName})`);
    if (report) {
      if (!report.lines.length) blockers.push("No transactions could be read from this file");
      else if (!isNew.some(Boolean) && !duplicateOf) blockers.push("Every transaction in this file is already imported");
      if (report.accountCheck.status === "mismatch") blockers.push(`This statement is for account ending ${(report.accountCheck.found ?? "").replace(/\D/g, "").slice(-4) || report.accountCheck.found}, not ${accountName(account)}`);
      if (report.errors.length) {
        const nums = report.errors.slice(0, 5).map((e) => e.rowNo);
        warnings.push(`${report.errors.length === 1 ? "Row" : "Rows"} ${nums.join(", ")}${report.errors.length > 5 ? " and others" : ""} could not be read and will NOT be imported (row ${report.errors[0].rowNo}: ${report.errors[0].message})`);
      }
      if (report.balanceCheck.status === "breaks") warnings.push(`The running balance does not add up at row ${report.balanceCheck.breaks.map((b) => b.rowNo).slice(0, 5).join(", ")} — a row may be missing from this file`);
      if (report.accountCheck.status === "not_stated") warnings.push("The statement does not state its account number — check it is the right account");
      const dups = possibleDuplicate.filter(Boolean).length;
      if (dups) warnings.push(`${dups} ${dups === 1 ? "line looks" : "lines look"} like transactions already imported in another format — they will be marked for review`);
      if (report.period) {
        const latest = await prisma.salesBankStatement.findFirst({ where: { bankAccountId: account.id, id: dup ? { not: dup.id } : undefined }, orderBy: { periodTo: "desc" }, select: { periodTo: true, closingBalancePaise: true, fileName: true } });
        if (latest) {
          const lastTo = dateToDay(latest.periodTo)!;
          if (lastTo < plusDays(report.period.from, -1)) warnings.push(`No statement covers ${shortDay(plusDays(lastTo, 1))} – ${shortDay(plusDays(report.period.from, -1))} — upload that period too`);
          if (lastTo === plusDays(report.period.from, -1) && latest.closingBalancePaise !== null && report.openingPaise !== null && latest.closingBalancePaise !== report.openingPaise) {
            warnings.push(`This statement opens at ${bankInr(n(report.openingPaise))} but ${latest.fileName} closed at ${bankInr(n(latest.closingBalancePaise))}`);
          }
        }
      }
    }
    return { account, sha, format: grid.format, sheets: grid.sheets, sheet: grid.sheet, rows, mapping, mappingSource, preset, needs, report, hashes, isNew, possibleDuplicate, duplicateOf, blockers, warnings, beforeCutover };
  } finally {
    parsing = false;
  }
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

function previewOf(file: UploadedFile, r: StatementRead) {
  const rep = r.report;
  const credits = rep?.lines.filter((l) => l.creditPaise > 0n) ?? [];
  const debits = rep?.lines.filter((l) => l.debitPaise > 0n) ?? [];
  const sum = (xs: ParsedLine[], k: "creditPaise" | "debitPaise") => n(xs.reduce((s, l) => s + l[k], 0n));
  const newCount = r.isNew.filter(Boolean).length;
  return {
    fileName: file.originalname, fileSha256: r.sha, fileBytes: file.size, format: r.format, sheets: r.sheets, sheet: r.sheet,
    preset: r.preset, presetLabel: r.preset ? BANK_PRESET_LABELS[r.preset] : null,
    headerRow: r.mapping?.headerRow ?? null,
    headers: r.mapping ? (r.rows[r.mapping.headerRow - 1] ?? []).map((c) => cut(String(c ?? ""), 60)) : [],
    firstRows: r.mapping ? [] : r.rows.slice(0, 40).map((row) => row.slice(0, 12).map((c) => cut(String(c ?? ""), 40))),
    mapping: r.mapping, mappingSource: r.mappingSource, needs: r.needs,
    accountCheck: rep?.accountCheck ?? { status: "not_stated" as const, found: null },
    counts: {
      rows: rep?.lines.length ?? 0, credits: credits.length, debits: debits.length, skipped: rep?.skipped.length ?? 0, errors: rep?.errors.length ?? 0,
      alreadyImported: (rep?.lines.length ?? 0) - newCount, possibleDuplicates: r.possibleDuplicate.filter(Boolean).length, newLines: newCount, beforeCutover: r.beforeCutover,
    },
    totals: { creditsPaise: sum(credits, "creditPaise"), debitsPaise: sum(debits, "debitPaise"), openingPaise: rep?.openingPaise == null ? null : n(rep.openingPaise), closingPaise: rep?.closingPaise == null ? null : n(rep.closingPaise) },
    period: rep?.period ?? null,
    balanceCheck: rep ? { status: rep.balanceCheck.status, breaks: rep.balanceCheck.breaks.map((b) => ({ rowNo: b.rowNo, expectedPaise: n(b.expectedPaise), foundPaise: n(b.foundPaise) })) } : { status: "no_balance_column" as const, breaks: [] },
    skipped: (rep?.skipped ?? []).slice(0, 50),
    errors: (rep?.errors ?? []).slice(0, 50),
    sample: (rep?.lines ?? []).slice(0, 10).map((l) => ({
      rowNo: l.rowNo, txnDate: l.txnDate, narration: cut(l.narration, 120), reference: l.reference,
      debitPaise: l.debitPaise > 0n ? n(l.debitPaise) : null, creditPaise: l.creditPaise > 0n ? n(l.creditPaise) : null,
      balancePaise: l.balancePaise === null ? null : n(l.balancePaise), alreadyImported: !r.isNew[rep!.lines.indexOf(l)],
    })),
    duplicateOf: r.duplicateOf ? { statementId: r.duplicateOf.statementId, fileName: r.duplicateOf.fileName, createdAt: r.duplicateOf.createdAt } : null,
    blockers: r.blockers, warnings: r.warnings, canImport: r.blockers.length === 0,
  };
}

/** Read a statement and say what an import would do. Writes NOTHING. */
export async function previewStatement(file: UploadedFile | undefined, body: BankStatementUploadInput, company: CompanyKey) {
  const r = await readStatement(file, body, company, "preview");
  return previewOf(file!, r);
}

export async function importStatement(file: UploadedFile | undefined, body: BankStatementImportInput, company: CompanyKey, actorId: string) {
  const r = await readStatement(file, body, company, "import");
  if (r.duplicateOf) throw new AppError(409, "DUPLICATE_STATEMENT", `This exact file was already imported on ${shortDay(dateToDay(r.duplicateOf.createdAt)!)} (${r.duplicateOf.fileName})`);
  if (r.report && r.report.lines.length && !r.isNew.some(Boolean)) {
    const first = await prisma.salesBankLine.findFirst({ where: { bankAccountId: r.account.id, dedupeHash: r.hashes[0] }, select: { statement: { select: { fileName: true } } } });
    throw new AppError(409, "NOTHING_NEW", `Every transaction in this file is already imported${first ? ` (from ${first.statement.fileName})` : ""}`);
  }
  if (r.blockers.length) throw new AppError(422, "STATEMENT_BLOCKED", r.blockers[0]);
  if (r.warnings.length && !body.acceptWarnings) throw new AppError(409, "WARNINGS_NOT_ACCEPTED", `Read the warnings and tick "Import anyway" to import this statement`);
  const rep = r.report!;
  const account = r.account;
  const matchFrom = dateToDay(account.matchFrom);
  const fresh = rep.lines.map((l, i) => ({ l, i })).filter((x) => r.isNew[x.i]);
  const now = new Date();

  const statement = await prisma.$transaction(async (tx) => {
    // Serialises imports per account: two overlapping files never store a line twice.
    await tx.$queryRaw`SELECT id FROM sales_bank_accounts WHERE id = ${account.id} FOR UPDATE`;
    const again = await tx.salesBankStatement.findUnique({ where: { bankAccountId_fileSha256: { bankAccountId: account.id, fileSha256: r.sha } }, select: { fileName: true, createdAt: true } });
    if (again) throw new AppError(409, "DUPLICATE_STATEMENT", `This exact file was already imported on ${shortDay(dateToDay(again.createdAt)!)} (${again.fileName})`);
    const nowExisting = new Set<string>();
    const freshHashes = fresh.map((x) => r.hashes[x.i]);
    for (let i = 0; i < freshHashes.length; i += 5000) {
      const chunk = freshHashes.slice(i, i + 5000);
      for (const f of await tx.$queryRaw<Array<{ dedupe_hash: string }>>`SELECT dedupe_hash FROM sales_bank_lines WHERE bank_account_id = ${account.id} AND dedupe_hash = ANY(${chunk}::text[])`) nowExisting.add(f.dedupe_hash);
    }
    const toInsert = fresh.filter((x) => !nowExisting.has(r.hashes[x.i]));
    if (!toInsert.length) throw new AppError(409, "NOTHING_NEW", "Every transaction in this file is already imported");
    const credit = toInsert.reduce((s, x) => s + x.l.creditPaise, 0n);
    const debit = toInsert.reduce((s, x) => s + x.l.debitPaise, 0n);
    const s = await tx.salesBankStatement.create({
      data: {
        companyKey: account.companyKey, bankAccountId: account.id, fileName: cut(file!.originalname, 200), fileSha256: r.sha, fileBytes: file!.size,
        format: r.format, preset: r.preset, mapping: { ...r.mapping!, headerSignature: headerSignature(r.rows[r.mapping!.headerRow - 1] ?? []) } as Prisma.InputJsonValue,
        periodFrom: dayToDate(rep.period!.from), periodTo: dayToDate(rep.period!.to),
        openingBalancePaise: rep.openingPaise, closingBalancePaise: rep.closingPaise,
        rowCount: rep.lines.length, newLineCount: toInsert.length, duplicateCount: rep.lines.length - toInsert.length, skippedCount: rep.skipped.length,
        creditTotalPaise: credit, debitTotalPaise: debit, warnings: r.warnings.length ? (r.warnings as Prisma.InputJsonValue) : Prisma.JsonNull, uploadedById: actorId,
      },
    });
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 1000) {
      const res = await tx.salesBankLine.createMany({
        skipDuplicates: true,
        data: toInsert.slice(i, i + 1000).map(({ l, i: k }) => {
          const ignore = l.debitPaise > 0n ? "debit" : matchFrom && l.txnDate < matchFrom ? "before_cutover" : null;
          return {
            statementId: s.id, bankAccountId: account.id, companyKey: account.companyKey, rowNo: l.rowNo, txnDate: dayToDate(l.txnDate),
            valueDate: l.valueDate ? dayToDate(l.valueDate) : null, narration: cut(l.narration || "—", 500), reference: l.reference ? cut(l.reference, 120) : null,
            utr: l.utr ? cut(l.utr, 40) : null, creditPaise: l.creditPaise, debitPaise: l.debitPaise, balancePaise: l.balancePaise, dedupeHash: r.hashes[k],
            status: ignore ? "ignored" : "unmatched", ignoreReason: ignore, ignoredAt: ignore ? now : null, ignoredById: ignore ? SYSTEM_ACTOR : null,
          };
        }),
      });
      inserted += res.count;
    }
    if (inserted !== toInsert.length) throw new Error(`[sales] bank import inserted ${inserted} of ${toInsert.length} lines`);
    await tx.$executeRaw`
      UPDATE sales_bank_lines n SET possible_duplicate = true
      WHERE n.statement_id = ${s.id} AND EXISTS (
        SELECT 1 FROM sales_bank_lines o
        WHERE o.bank_account_id = n.bank_account_id AND o.statement_id <> n.statement_id
          AND o.txn_date = n.txn_date AND o.credit_paise = n.credit_paise AND o.debit_paise = n.debit_paise
          AND (o.balance_paise IS NULL OR n.balance_paise IS NULL OR o.balance_paise = n.balance_paise OR (o.utr IS NOT NULL AND o.utr = n.utr))
          AND o.dedupe_hash <> n.dedupe_hash)`;
    const p = rep.period!;
    await logSalesEvent(tx, {
      entityType: "bank_statement", entityId: s.id, actorId, action: "imported",
      note: `${s.fileName} · ${shortDay(p.from)} – ${shortDay(p.to)} · ${toInsert.length} new, ${rep.lines.length - toInsert.length} already imported`,
    });
    return s;
  }, { timeout: 30_000, maxWait: 5_000 });

  await rematchCompany(account.companyKey as CompanyKey, actorId).catch((err) => console.error("[sales] bank rematch after import failed", err));
  await writeDebitHints(statement.id).catch((err) => console.error("[sales] bank debit hints failed", err));
  const lines = await prisma.salesBankLine.findMany({ where: { statementId: statement.id }, select: { creditPaise: true, status: true, confidence: true, payments: { select: { id: true }, take: 1 } } });
  const cr = lines.filter((l) => l.creditPaise > 0n);
  return {
    statement: (await listStatements({ statementId: statement.id }))[0],
    newLines: lines.length, duplicates: statement.duplicateCount, credits: cr.length, debits: lines.length - cr.length,
    autoLinked: cr.filter((l) => l.payments.length).length,
    suggested: cr.filter((l) => l.status === "suggested").length,
    sure: cr.filter((l) => l.status === "suggested" && l.confidence === "high").length,
    unmatched: cr.filter((l) => l.status === "unmatched").length,
  };
}

async function writeDebitHints(statementId: string) {
  const debits = await prisma.salesBankLine.findMany({ where: { statementId, debitPaise: { gt: 0 } }, select: { id: true, txnDate: true, debitPaise: true, narration: true, companyKey: true, bankAccountId: true } });
  if (!debits.length) return;
  const days = debits.map((d) => dateToDay(d.txnDate)!).sort();
  const from = plusDays(days[0], -10);
  const to = plusDays(days[days.length - 1], 3);
  const refunds = await prisma.salesRefund.findMany({
    where: { status: "issued", payment: { companyKey: debits[0].companyKey }, refundedOn: { gte: dayToDate(plusDays(days[0], -3)), lte: dayToDate(to) } },
    select: { id: true, number: true, amountPaise: true, refundedOn: true },
  });
  const credits = await prisma.salesBankLine.findMany({
    where: { bankAccountId: debits[0].bankAccountId, creditPaise: { gt: 0 }, matchedPaise: { gt: 0 }, txnDate: { gte: dayToDate(from), lte: dayToDate(to) } },
    select: { id: true, txnDate: true, creditPaise: true, payments: { where: { status: "recorded" }, select: { number: true } } },
  });
  const hints = matchDebits(
    debits.map((d) => ({ id: d.id, txnDate: dateToDay(d.txnDate)!, debitPaise: n(d.debitPaise), narration: d.narration })),
    {
      refunds: refunds.map((r) => ({ id: r.id, number: r.number, amountPaise: r.amountPaise, refundedOn: dateToDay(r.refundedOn)! })),
      matchedCredits: credits.map((c) => ({ lineId: c.id, txnDate: dateToDay(c.txnDate)!, creditPaise: n(c.creditPaise), receiptNumbers: c.payments.map((p) => p.number) })),
    },
  );
  for (const [id, debitHint] of Object.entries(hints)) {
    await prisma.salesBankLine.update({ where: { id }, data: { suggestion: { v: 1, debitHint } as Prisma.InputJsonValue } });
  }
}

export async function listStatements(filter: { company?: CompanyKey; accountId?: string; statementId?: string }) {
  const rows = await prisma.salesBankStatement.findMany({
    where: {
      ...(filter.company ? { companyKey: filter.company } : {}),
      ...(filter.accountId ? { bankAccountId: filter.accountId } : {}),
      ...(filter.statementId ? { id: filter.statementId } : {}),
    },
    orderBy: [{ periodTo: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: { bankAccount: { select: { label: true, bank: true, accountNumber: true } } },
  });
  const counts = rows.length
    ? await prisma.salesBankLine.groupBy({ by: ["statementId", "status"], where: { statementId: { in: rows.map((r) => r.id) } }, _count: true })
    : [];
  return rows.map((s) => {
    const lineCounts: Record<string, number> = { unmatched: 0, suggested: 0, partly_matched: 0, matched: 0, ignored: 0 };
    for (const c of counts.filter((x) => x.statementId === s.id)) lineCounts[c.status] = c._count;
    return {
      id: s.id, companyKey: s.companyKey, bankAccountId: s.bankAccountId,
      account: { label: s.bankAccount.label, bank: s.bankAccount.bank, last4: last4(s.bankAccount.accountNumber) },
      fileName: s.fileName, format: s.format, periodFrom: dateToDay(s.periodFrom), periodTo: dateToDay(s.periodTo),
      rowCount: s.rowCount, newLineCount: s.newLineCount, duplicateCount: s.duplicateCount, skippedCount: s.skippedCount,
      creditTotalPaise: n(s.creditTotalPaise), debitTotalPaise: n(s.debitTotalPaise),
      openingBalancePaise: s.openingBalancePaise === null ? null : n(s.openingBalancePaise), closingBalancePaise: s.closingBalancePaise === null ? null : n(s.closingBalancePaise),
      warnings: (s.warnings as string[] | null) ?? null, uploadedById: s.uploadedById, createdAt: s.createdAt, lineCounts,
    };
  });
}

export async function getStatement(id: string, opts: { seeDebits: boolean }) {
  const [s] = await listStatements({ statementId: id });
  if (!s) throw new AppError(404, "NOT_FOUND", "Statement not found");
  const rows = await prisma.salesBankLine.findMany({ where: { statementId: id }, orderBy: { rowNo: "asc" }, take: 5000, include: lineInclude });
  return { ...s, lines: await hydrate(rows, opts) };
}

export async function deleteStatement(id: string, reason: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const found = await tx.$queryRaw<Array<{ id: string; file_name: string }>>`SELECT id, file_name FROM sales_bank_statements WHERE id = ${id} FOR UPDATE`;
    if (!found.length) throw new AppError(404, "NOT_FOUND", "Statement not found");
    const used = await tx.$queryRaw<Array<{ number: string }>>`
      SELECT p.number FROM sales_payments p JOIN sales_bank_lines l ON l.id = p.bank_line_id WHERE l.statement_id = ${id} ORDER BY p.number LIMIT 3`;
    if (used.length) throw new AppError(409, "STATEMENT_IN_USE", `Receipts were recorded from this statement (${used.map((u) => u.number).join(", ")}${used.length === 3 ? "…" : ""}) — unlink them before deleting it`);
    await tx.salesBankStatement.delete({ where: { id } });
    await logSalesEvent(tx, { entityType: "bank_statement", entityId: id, actorId, action: "deleted", note: `${found[0].file_name} — ${reason}` });
  });
  return { deleted: true };
}

// ── Lines: reading ────────────────────────────────────────────────────────────────

const lineInclude = {
  bankAccount: { select: { label: true, bank: true, accountNumber: true } },
  statement: { select: { fileName: true } },
  payments: {
    orderBy: { createdAt: "desc" as const },
    select: { id: true, number: true, amountPaise: true, tdsPaise: true, status: true, paidOn: true, client: { select: { companyName: true } } },
  },
} as const;
type LineRow = Prisma.SalesBankLineGetPayload<{ include: typeof lineInclude }>;
type StoredSuggestion = (MatchResult & { sig?: string }) | { v: 1; debitHint: unknown } | null;

async function hydrate(rows: LineRow[], opts: { seeDebits: boolean }) {
  const clientIds = new Set<string>();
  const invoiceIds = new Set<string>();
  for (const r of rows) {
    const s = r.suggestion as StoredSuggestion;
    if (!s || !("candidates" in s)) continue;
    for (const c of s.candidates) { clientIds.add(c.clientId); for (const a of c.allocations) invoiceIds.add(a.invoiceId); }
    for (const rc of s.receiptCandidates) clientIds.add(rc.clientId);
  }
  const [clients, invoices] = await Promise.all([
    clientIds.size ? prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, companyName: true } }) : [],
    invoiceIds.size ? prisma.salesInvoice.findMany({ where: { id: { in: [...invoiceIds] } }, select: { id: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true, status: true } }) : [],
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.companyName]));
  const live = new Map(invoices.map((i) => [i.id, i.status === "issued" ? i.totalPaise - i.paidPaise - i.tdsPaise - i.creditedPaise : 0]));
  return rows.map((r) => {
    const isDebit = r.debitPaise > 0n;
    const redact = isDebit && !opts.seeDebits;
    const s = r.suggestion as StoredSuggestion;
    const credit = n(r.creditPaise);
    const matched = n(r.matchedPaise);
    const suggestion = s && "candidates" in s ? {
      candidates: s.candidates.map((c) => {
        const allocations = c.allocations.map((a) => ({ ...a, liveBalancePaise: live.get(a.invoiceId) ?? 0 }));
        return { ...c, client: { id: c.clientId, companyName: clientName.get(c.clientId) ?? "Unknown client" }, allocations, stale: allocations.some((a) => a.liveBalancePaise !== a.balancePaise) };
      }),
      receiptCandidates: s.receiptCandidates.map((x) => ({ ...x, clientName: clientName.get(x.clientId) ?? "Unknown client" })),
      conflict: s.conflict, ignoreHint: s.ignoreHint, note: s.note,
    } : null;
    return {
      id: r.id, companyKey: r.companyKey, bankAccountId: r.bankAccountId,
      account: { label: r.bankAccount.label, bank: r.bankAccount.bank, last4: last4(r.bankAccount.accountNumber) },
      statementId: r.statementId, statement: { fileName: r.statement.fileName }, rowNo: r.rowNo,
      txnDate: dateToDay(r.txnDate)!, valueDate: dateToDay(r.valueDate),
      narration: redact ? "" : r.narration, reference: redact ? null : r.reference, utr: redact ? null : r.utr, ...(redact ? { redacted: true as const } : {}),
      creditPaise: credit, debitPaise: n(r.debitPaise), balancePaise: r.balancePaise === null ? null : n(r.balancePaise),
      status: r.status, matchedPaise: matched, remainingPaise: Math.max(0, credit - matched), possibleDuplicate: r.possibleDuplicate,
      bestScore: r.bestScore, confidence: r.confidence, ignoreReason: r.ignoreReason, ignoreNote: r.ignoreNote,
      suggestion: isDebit ? null : suggestion,
      debitHint: isDebit && s && "debitHint" in s ? s.debitHint : null,
      receipts: r.payments.map((p) => ({ id: p.id, number: p.number, clientName: p.client.companyName, amountPaise: p.amountPaise, tdsPaise: p.tdsPaise, status: p.status, paidOn: dateToDay(p.paidOn) })),
    };
  });
}
export type BankLineView = Awaited<ReturnType<typeof hydrate>>[number];

export async function getBankLine(id: string, opts: { seeDebits: boolean }) {
  const row = await prisma.salesBankLine.findUnique({ where: { id }, include: lineInclude });
  if (!row) throw new AppError(404, "NOT_FOUND", "Bank line not found");
  return (await hydrate([row], opts))[0];
}

/** "116000", "1,16,000.00" → paise; anything else → null (then the query is text). */
function rupeesQuery(q: string): number | null {
  const s = q.replace(/[₹,\s]/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}

export type BankTab = "review" | "sure" | "matched" | "ignored" | "debits" | "all";
export async function listBankLines(filter: { company?: CompanyKey; tab?: BankTab; accountId?: string; statementId?: string; q?: string }, opts: { seeDebits: boolean }) {
  const scope: Prisma.SalesBankLineWhereInput = {
    ...(filter.company ? { companyKey: filter.company } : {}),
    ...(filter.accountId ? { bankAccountId: filter.accountId } : {}),
    ...(filter.statementId ? { statementId: filter.statementId } : {}),
  };
  const tab = filter.tab ?? "review";
  const credit = { creditPaise: { gt: 0 } };
  const tabWhere: Record<BankTab, Prisma.SalesBankLineWhereInput> = {
    review: { ...credit, status: { in: OPEN_STATUSES } },
    sure: { ...credit, status: "suggested", confidence: "high" },
    matched: { ...credit, status: "matched" },
    ignored: { ...credit, status: "ignored" },
    debits: { debitPaise: { gt: 0 } },
    all: {},
  };
  const q = filter.q?.trim();
  const amount = q ? rupeesQuery(q) : null;
  const search: Prisma.SalesBankLineWhereInput = !q ? {}
    : amount !== null ? { OR: [{ creditPaise: BigInt(amount) }, { debitPaise: BigInt(amount) }] }
    : { OR: [{ narration: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }, { utr: { contains: q, mode: "insensitive" } }] };
  const ranked = tab === "review" || tab === "sure";
  const rows = await prisma.salesBankLine.findMany({
    where: { AND: [scope, tabWhere[tab], search, ...(tab === "debits" && !opts.seeDebits && q && amount === null ? [{ id: "none" }] : [])] },
    orderBy: [...(ranked ? [{ bestScore: { sort: "desc" as const, nulls: "last" as const } }] : []), { txnDate: "desc" }, { rowNo: "desc" }],
    take: 500,
    include: lineInclude,
  });
  const countOf = (w: Prisma.SalesBankLineWhereInput) => prisma.salesBankLine.count({ where: { AND: [scope, w] } });
  const [review, sure, matched, ignored, debits] = await Promise.all([countOf(tabWhere.review), countOf(tabWhere.sure), countOf(tabWhere.matched), countOf(tabWhere.ignored), countOf(tabWhere.debits)]);
  return {
    lines: await hydrate(rows, opts),
    counts: { review, sure, matched, ignored, debits },
    summary: filter.company ? await bankSummary(filter.company) : null,
  };
}

/** Receipts that could be this credit: same company, recorded, not on a line, within ±31 days. Swipe imports last. */
export async function unlinkedReceiptsFor(lineId: string) {
  const line = await prisma.salesBankLine.findUnique({ where: { id: lineId } });
  if (!line) throw new AppError(404, "NOT_FOUND", "Bank line not found");
  const day = dateToDay(line.txnDate)!;
  const remaining = n(line.creditPaise) - (await liveMatched(prisma, lineId));
  const rows = await prisma.salesPayment.findMany({
    where: {
      companyKey: line.companyKey, status: "recorded", bankLineId: null, mode: { not: "razorpay" },
      paidOn: { gte: dayToDate(plusDays(day, -31)), lte: dayToDate(plusDays(day, 31)) }, amountPaise: { lte: remaining + 100 },
    },
    take: 200,
    select: { id: true, number: true, amountPaise: true, tdsPaise: true, paidOn: true, reference: true, mode: true, client: { select: { id: true, companyName: true } } },
  });
  return rows
    .map((p) => {
      const days = Math.abs(daysBetween(dateToDay(p.paidOn)!, day));
      const imported = p.number.startsWith("SW-");
      const tags = [Math.abs(p.amountPaise - remaining) <= 100 ? "exact amount" : null, days <= 3 ? "±3 days" : null, imported ? "Swipe import" : null].filter(Boolean);
      return { paymentId: p.id, number: p.number, clientId: p.client.id, clientName: p.client.companyName, amountPaise: p.amountPaise, tdsPaise: p.tdsPaise, paidOn: dateToDay(p.paidOn), reference: p.reference, mode: p.mode, days, imported, why: tags.join(" · ") };
    })
    .sort((a, b) => Number(a.imported) - Number(b.imported) || Math.abs(a.amountPaise - remaining) - Math.abs(b.amountPaise - remaining) || a.days - b.days || (a.number < b.number ? -1 : 1))
    .slice(0, 20);
}

// ── Line state ────────────────────────────────────────────────────────────────────

async function lockBankLine(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM sales_bank_lines WHERE id = ${id} FOR UPDATE`;
  const line = await tx.salesBankLine.findUnique({ where: { id }, include: { bankAccount: true, statement: { select: { fileName: true } } } });
  if (!line) throw new AppError(404, "NOT_FOUND", "Bank line not found");
  return line;
}

/** Σ amountPaise of RECORDED receipts on the line (voided ones keep their link but stop counting). */
async function liveMatched(tx: Tx | typeof prisma, lineId: string): Promise<number> {
  const a = await tx.salesPayment.aggregate({ where: { bankLineId: lineId, status: "recorded" }, _sum: { amountPaise: true } });
  return a._sum.amountPaise ?? 0;
}

/** The ONLY writer of a line's status and matched_paise. The caller holds the line lock. */
export async function refreshBankLine(tx: Tx, lineId: string): Promise<void> {
  const line = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId } });
  const matched = BigInt(await liveMatched(tx, lineId));
  const credit = line.creditPaise;
  const status = line.ignoredAt ? "ignored"
    : credit > 0n && matched > 0n && matched >= credit - 100n ? "matched" // ±₹1: an auto-linked receipt may differ by paise
    : matched > 0n ? "partly_matched"
    : line.confidence === "high" || line.confidence === "medium" ? "suggested"
    : "unmatched";
  if (matched > credit + 100n) console.warn(`[sales] bank line ${lineId} over-matched`); // never thrown: the void path must not fail
  if (status !== line.status || matched !== line.matchedPaise) await tx.salesBankLine.update({ where: { id: lineId }, data: { status, matchedPaise: matched } });
}

export async function refreshBankLineById(lineId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_bank_lines WHERE id = ${lineId} FOR UPDATE`;
    await refreshBankLine(tx, lineId);
  });
}

/** voidPayment's post-commit hook: the receipt on this line was voided from its own page. */
export async function refreshBankLineAfterVoid(lineId: string, paymentId: string, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM sales_bank_lines WHERE id = ${lineId} FOR UPDATE`;
    if (!rows.length) return;
    await refreshBankLine(tx, lineId);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId }, select: { status: true } });
    const p = await tx.salesPayment.findUnique({ where: { id: paymentId }, select: { number: true } });
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId, action: "receipt_voided", fromStatus: rows[0].status, toStatus: after.status, note: `${p?.number ?? paymentId} voided from the receipt page` });
  });
}

function tdsNote(tdsPaise: number, rateBp: number | null | undefined, section: string | null | undefined, taxable: number | null) {
  if (tdsPaise <= 0) return null;
  const rate = rateBp ? ` = ${bankPct(rateBp)}` : "";
  const of = taxable ? ` of taxable ${bankInr(taxable)}` : "";
  return `TDS ${bankInr(tdsPaise)}${rate}${rate ? of : ""}${section ? ` (${section})` : ""}`;
}

/** Record a receipt from a credit (also "Record as advance" with allocations: []). */
export async function confirmBankLine(lineId: string, input: BankLineConfirmInput, actorId: string, opts: { rematch: boolean } = { rematch: true }) {
  const pre = await prisma.salesBankLine.findUnique({ where: { id: lineId }, select: { companyKey: true } });
  if (!pre) throw new AppError(404, "NOT_FOUND", "Bank line not found");
  const company = pre.companyKey as CompanyKey;
  const seller = await getSellerOrDefaults(company);
  const result = await prisma.$transaction(async (tx) => {
    const line = await lockBankLine(tx, lineId);
    if (line.debitPaise > 0n || line.creditPaise <= 0n) throw new AppError(409, "BANK_LINE_NOT_CREDIT", "Only a credit can be recorded as a receipt");
    if (line.ignoredAt) throw new AppError(409, "BANK_LINE_IGNORED", `This credit is ignored (${BANK_IGNORE_LABELS[line.ignoreReason ?? "other"] ?? line.ignoreReason}) — reopen it first`);
    const matchedNow = await liveMatched(tx, lineId);
    const remaining = n(line.creditPaise) - matchedNow;
    if (remaining <= 0) {
      const p = await tx.salesPayment.findFirst({ where: { bankLineId: lineId, status: "recorded" }, select: { number: true } });
      throw new AppError(409, "BANK_LINE_SETTLED", `This credit is already fully recorded${p ? ` (${p.number})` : ""}`);
    }
    if (input.amountPaise > remaining) throw new AppError(409, "OVER_MATCHED", `Only ${bankInr(remaining)} of this credit is left to record`);
    const txnDay = dateToDay(line.txnDate)!;
    if (line.possibleDuplicate && !input.ackDuplicateLine) {
      const twin = await tx.salesBankLine.findFirst({
        where: { bankAccountId: line.bankAccountId, statementId: { not: line.statementId }, txnDate: line.txnDate, creditPaise: line.creditPaise, debitPaise: line.debitPaise },
        select: { rowNo: true, statement: { select: { fileName: true } } },
      });
      throw new AppError(409, "POSSIBLE_DUPLICATE", `This looks like the same transaction as ${twin ? `row ${twin.rowNo} of ${twin.statement.fileName}` : "a line imported earlier"} — ignore it as a duplicate, or confirm it is a separate payment`);
    }
    if (!input.ackExistingReceipt) {
      const or: Prisma.SalesPaymentWhereInput[] = [{ paidOn: { gte: dayToDate(plusDays(txnDay, -7)), lte: dayToDate(plusDays(txnDay, 7)) } }];
      if (line.utr && line.utr.length >= 10) or.push({ reference: { contains: line.utr, mode: "insensitive" } });
      const twin = await tx.salesPayment.findFirst({
        where: { companyKey: company, clientId: input.clientId, status: "recorded", bankLineId: null, amountPaise: { gte: input.amountPaise - 100, lte: input.amountPaise + 100 }, OR: or },
        orderBy: { paidOn: "desc" },
        select: { number: true, amountPaise: true, paidOn: true, client: { select: { companyName: true } } },
      });
      if (twin) throw new AppError(409, "POSSIBLE_DOUBLE_RECEIPT", `${twin.number} (${bankInr(twin.amountPaise)} from ${twin.client.companyName} on ${shortDay(dateToDay(twin.paidOn)!)}) looks like this same money — link it instead, or confirm this is a separate payment`);
    }
    const allocations = input.allocations.filter((a) => a.amountPaise + a.tdsPaise > 0);
    let taxableTotal: number | null = null;
    if (input.tdsPaise > 0 && allocations.length) {
      const invs = await tx.salesInvoice.findMany({ where: { id: { in: allocations.map((a) => a.invoiceId) } }, select: { id: true, taxablePaise: true } });
      const cns = await tx.salesCreditNote.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: invs.map((i) => i.id) }, status: "issued" }, _sum: { taxablePaise: true } });
      const nets = invs.map((i) => netTaxable({ taxablePaise: i.taxablePaise, creditedTaxablePaise: cns.find((c) => c.invoiceId === i.id)?._sum.taxablePaise ?? 0 }));
      taxableTotal = nets.reduce((s, x) => s + x, 0);
      const ceiling = nets.reduce((s, x) => s + tdsAt(x, 1000), 0) + 100 * nets.length;
      if (!input.ackHighTds && input.tdsPaise > ceiling) {
        const pct = taxableTotal > 0 ? ((input.tdsPaise * 100) / taxableTotal).toFixed(1) : "∞";
        throw new AppError(422, "TDS_TOO_HIGH", `TDS of ${bankInr(input.tdsPaise)} is ${pct}% of the taxable value — above every normal rate. Record it anyway?`);
      }
    }
    const account = line.bankAccount;
    const note = tdsNote(input.tdsPaise, input.tdsRateBp, input.tdsSection, taxableTotal);
    const parsed = paymentCreateSchema.safeParse({
      companyKey: company, clientId: input.clientId, amountPaise: input.amountPaise, tdsPaise: input.tdsPaise,
      tdsRateBp: input.tdsPaise > 0 ? input.tdsRateBp ?? null : null, tdsSection: input.tdsPaise > 0 ? input.tdsSection ?? null : null, mode: "bank_transfer",
      reference: (line.utr ?? line.reference ?? line.narration).slice(0, 120), paidOn: txnDay, bankName: accountName(account).slice(0, 120),
      notes: [`Bank statement ${line.statement.fileName}, row ${line.rowNo}: ${line.narration}`, note, input.notes].filter(Boolean).join("\n").slice(0, 2000),
      allocations,
    });
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues[0].message);
    const p = await recordReceiptTx(tx, parsed.data, actorId, {
      receiptPrefix: seller.receiptPrefix,
      columns: { bankLineId: line.id, tdsRateBp: parsed.data.tdsRateBp ?? null, tdsSection: parsed.data.tdsSection ?? null },
    });
    await refreshBankLine(tx, line.id);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: line.id }, select: { status: true } });
    const invNumbers = allocations.length ? (await tx.salesInvoice.findMany({ where: { id: { in: allocations.map((a) => a.invoiceId) } }, select: { number: true } })).map((i) => i.number).join(", ") : "advance";
    const rateText = parsed.data.tdsRateBp ? ` (${bankPct(parsed.data.tdsRateBp)}${parsed.data.tdsSection ? ` ${parsed.data.tdsSection}` : ""})` : "";
    await logSalesEvent(tx, {
      entityType: "bank_line", entityId: line.id, actorId, action: "receipt_recorded", fromStatus: line.status, toStatus: after.status,
      note: `${p.number} · ${bankInr(input.amountPaise)}${input.tdsPaise ? ` + TDS ${bankInr(input.tdsPaise)}${rateText}` : ""} → ${invNumbers}`,
    });
    await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: "bank_matched", note: `${accountName(account)} · ${shortDay(txnDay)} · row ${line.rowNo} of ${line.statement.fileName}` });
    return p;
  }, { timeout: 20_000, maxWait: 10_000 });
  queueInvoiceEmails(result.invoiceIds, result.id, actorId);
  if (opts.rematch) await rematchCompany(company, actorId).catch((err) => console.error("[sales] bank rematch failed", err));
  return { line: await getBankLine(lineId, { seeDebits: true }), payment: await getPayment(result.id) };
}

/** Confirm the stored top candidate of up to 25 sure lines, each in its own transaction. */
export async function confirmSureLines(lineIds: string[], actorId: string) {
  const confirmed: Array<{ lineId: string; number: string }> = [];
  const skipped: Array<{ lineId: string; message: string }> = [];
  const companies = new Set<CompanyKey>();
  for (const id of lineIds) {
    const line = await prisma.salesBankLine.findUnique({ where: { id } });
    if (!line) { skipped.push({ lineId: id, message: "Bank line not found" }); continue; }
    companies.add(line.companyKey as CompanyKey);
    const s = line.suggestion as StoredSuggestion;
    const top = s && "candidates" in s ? s.candidates[0] : null;
    const why = line.status !== "suggested" || line.confidence !== "high" ? "It is no longer marked sure — review it"
      : !top || !s || !("candidates" in s) ? "It has no suggestion — review it"
      : s.conflict ? `${s.conflict.invoiceNumber} is suggested for another credit — review it`
      : s.receiptCandidates.length ? `${s.receiptCandidates[0].number} may already be this money — review it`
      : line.possibleDuplicate ? "It may be a duplicate of an earlier line — review it"
      : line.creditPaise > BigInt(MAX_PAISE) ? "It is larger than one receipt can hold — record it in parts"
      : null;
    if (why) { skipped.push({ lineId: id, message: why }); continue; }
    const invs = await prisma.salesInvoice.findMany({ where: { id: { in: top!.allocations.map((a) => a.invoiceId) } }, select: { id: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true, status: true } });
    const stale = top!.allocations.some((a) => {
      const i = invs.find((x) => x.id === a.invoiceId);
      return !i || i.status !== "issued" || i.totalPaise - i.paidPaise - i.tdsPaise - i.creditedPaise !== a.balancePaise;
    });
    if (stale) { skipped.push({ lineId: id, message: "Balances changed since the suggestion — review it" }); continue; }
    try {
      const r = await confirmBankLine(id, {
        clientId: top!.clientId, amountPaise: top!.amountPaise, tdsPaise: top!.tdsPaise, tdsRateBp: top!.tdsRateBp, tdsSection: (top!.tdsSection as "194C" | "194J" | null) ?? null,
        allocations: top!.allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise })),
        notes: null, ackDuplicateLine: false, ackExistingReceipt: false, ackHighTds: false,
      }, actorId, { rematch: false });
      confirmed.push({ lineId: id, number: r.payment.number });
    } catch (err) {
      if (err instanceof AppError) skipped.push({ lineId: id, message: err.message });
      else throw err;
    }
  }
  for (const c of companies) await rematchCompany(c, actorId).catch((err) => console.error("[sales] bank rematch failed", err));
  return { confirmed, skipped };
}

export async function linkReceipt(lineId: string, paymentId: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const line = await lockBankLine(tx, lineId);
    if (line.debitPaise > 0n || line.creditPaise <= 0n) throw new AppError(409, "BANK_LINE_NOT_CREDIT", "Only a credit can be recorded as a receipt");
    if (line.ignoredAt) throw new AppError(409, "BANK_LINE_IGNORED", `This credit is ignored (${BANK_IGNORE_LABELS[line.ignoreReason ?? "other"] ?? line.ignoreReason}) — reopen it first`);
    const p = await lockPayment(tx, paymentId);
    if (p.status !== "recorded") throw new AppError(409, "PAYMENT_VOIDED", `${p.number} was voided — it cannot be matched`);
    if (p.companyKey !== line.companyKey) throw new AppError(409, "WRONG_COMPANY", `${p.number} is ${SALES_COMPANIES[p.companyKey as CompanyKey]?.short ?? "the other company"}'s receipt`);
    if (p.mode === "razorpay") throw new AppError(409, "RAZORPAY_RECEIPT", "Razorpay receipts are settled in batches net of fees — they are not matched to single bank credits");
    if (p.bankLineId) {
      const other = await tx.salesBankLine.findUnique({ where: { id: p.bankLineId }, select: { txnDate: true } });
      throw new AppError(409, "RECEIPT_ALREADY_LINKED", `${p.number} is already matched to a bank credit of ${other ? shortDay(dateToDay(other.txnDate)!) : "another day"}`);
    }
    const txnDay = dateToDay(line.txnDate)!;
    const apart = Math.abs(daysBetween(dateToDay(p.paidOn)!, txnDay));
    if (apart > 31) throw new AppError(422, "RECEIPT_DATE_FAR", `${p.number} is dated ${shortDay(dateToDay(p.paidOn)!)}, ${apart} days from this credit — check you picked the right receipt`);
    const matched = await liveMatched(tx, lineId);
    if (matched + p.amountPaise > n(line.creditPaise) + 100) throw new AppError(409, "OVER_MATCHED", `Only ${bankInr(Math.max(0, n(line.creditPaise) - matched))} of this credit is left to record`);
    await tx.salesPayment.update({ where: { id: paymentId }, data: { bankLineId: lineId } });
    await refreshBankLine(tx, lineId);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId }, select: { status: true } });
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId, action: "receipt_linked", fromStatus: line.status, toStatus: after.status, note: `${p.number} · ${bankInr(p.amountPaise)}` });
    await logSalesEvent(tx, { entityType: "payment", entityId: paymentId, actorId, action: "bank_matched", note: `${accountName(line.bankAccount)} · ${shortDay(txnDay)} · row ${line.rowNo} of ${line.statement.fileName}` });
  }, { maxWait: 10_000 });
  return { line: await getBankLine(lineId, { seeDebits: true }), payment: await getPayment(paymentId) };
}

export async function unlinkReceipt(lineId: string, input: BankLineUnlinkInput, actorId: string) {
  const company = await prisma.$transaction(async (tx) => {
    const line = await lockBankLine(tx, lineId);
    const pay = await tx.salesPayment.findUnique({ where: { id: input.paymentId }, select: { bankLineId: true, number: true } });
    if (!pay || pay.bankLineId !== lineId) throw new AppError(409, "RECEIPT_NOT_LINKED", "That receipt is not on this bank line");
    if (input.action === "detach") {
      await lockPayment(tx, input.paymentId);
      await tx.salesPayment.update({ where: { id: input.paymentId }, data: { bankLineId: null } });
    } else {
      await voidPaymentInTx(tx, input.paymentId, input.reason, actorId);
    }
    await refreshBankLine(tx, lineId);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId }, select: { status: true } });
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId, action: input.action === "detach" ? "receipt_detached" : "receipt_voided", fromStatus: line.status, toStatus: after.status, note: `${pay.number} — ${input.reason}` });
    if (input.action === "detach") await logSalesEvent(tx, { entityType: "payment", entityId: input.paymentId, actorId, action: "bank_unlinked", note: input.reason });
    return line.companyKey as CompanyKey;
  }, { maxWait: 10_000 });
  await rematchCompany(company, actorId).catch((err) => console.error("[sales] bank rematch failed", err));
  return { line: await getBankLine(lineId, { seeDebits: true }), payment: await getPayment(input.paymentId) };
}

export async function ignoreBankLine(lineId: string, input: BankLineIgnoreInput, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const line = await lockBankLine(tx, lineId);
    if (line.debitPaise > 0n) throw new AppError(409, "BANK_LINE_NOT_CREDIT", "Only a credit can be ignored or reopened — withdrawals are ignored already");
    if (line.ignoredAt) return;
    if ((await liveMatched(tx, lineId)) > 0) throw new AppError(409, "BANK_LINE_HAS_RECEIPTS", "Receipts are recorded from this credit — unlink them before ignoring it");
    await tx.salesBankLine.update({ where: { id: lineId }, data: { ignoreReason: input.reason, ignoreNote: input.note ?? null, ignoredAt: new Date(), ignoredById: actorId } });
    await refreshBankLine(tx, lineId);
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId, action: "ignored", fromStatus: line.status, toStatus: "ignored", note: [BANK_IGNORE_LABELS[input.reason], input.note].filter(Boolean).join(" · ") });
  });
  return { line: await getBankLine(lineId, { seeDebits: true }) };
}

export async function reopenBankLine(lineId: string, actorId: string) {
  const company = await prisma.$transaction(async (tx) => {
    const line = await lockBankLine(tx, lineId);
    if (line.debitPaise > 0n) throw new AppError(409, "BANK_LINE_NOT_CREDIT", "Only a credit can be ignored or reopened — withdrawals are ignored already");
    if (!line.ignoredAt) return null;
    await tx.salesBankLine.update({ where: { id: lineId }, data: { ignoreReason: null, ignoreNote: null, ignoredAt: null, ignoredById: null } });
    await refreshBankLine(tx, lineId);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId }, select: { status: true } });
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId, action: "reopened", fromStatus: "ignored", toStatus: after.status });
    return line.companyKey as CompanyKey;
  });
  if (company) await rematchCompany(company, actorId).catch((err) => console.error("[sales] bank rematch failed", err));
  return { line: await getBankLine(lineId, { seeDebits: true }) };
}

/**
 * Owner (2026-11-05): ignore, in one go, every still-open credit dated before a day — old credits
 * whose invoices never reached the portal. Only credits with NO recorded receipt; by default only
 * those with nothing suggested. Each batch locks its lines (SKIP LOCKED: a line someone is
 * confirming right now is left alone) and re-checks under the lock.
 */
export async function ignoreUnmatchedBefore(company: CompanyKey, input: BankIgnoreBeforeInput, actorId: string) {
  const statuses = input.includeSuggested ? ["unmatched", "suggested"] : ["unmatched"];
  let ignored = 0;
  let lastId = "";
  for (let guard = 0; guard < 200; guard++) {
    const ids = (await prisma.salesBankLine.findMany({
      where: {
        companyKey: company, creditPaise: { gt: 0 }, ignoredAt: null, status: { in: statuses }, matchedPaise: 0, txnDate: { lt: dayToDate(input.before) },
        ...(input.accountId ? { bankAccountId: input.accountId } : {}), ...(lastId ? { id: { gt: lastId } } : {}),
      },
      orderBy: { id: "asc" }, take: 500, select: { id: true },
    })).map((r) => r.id);
    if (!ids.length) break;
    lastId = ids[ids.length - 1];
    ignored += await prisma.$transaction(async (tx) => {
      const locked = (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_bank_lines WHERE id = ANY(${ids}::text[]) FOR UPDATE SKIP LOCKED`).map((r) => r.id);
      if (!locked.length) return 0;
      // Re-read under the lock: a receipt may have landed since the list was read.
      const ok = (await tx.$queryRaw<Array<{ id: string }>>`
        SELECT l.id FROM sales_bank_lines l
        WHERE l.id = ANY(${locked}::text[]) AND l.ignored_at IS NULL AND l.status = ANY(${statuses}::text[])
          AND NOT EXISTS (SELECT 1 FROM sales_payments p WHERE p.bank_line_id = l.id AND p.status = 'recorded')`).map((r) => r.id);
      if (!ok.length) return 0;
      const now = new Date();
      // Exactly what refreshBankLine would write for an ignored line with no receipts.
      await tx.salesBankLine.updateMany({ where: { id: { in: ok } }, data: { ignoreReason: input.reason, ignoreNote: input.note ?? null, ignoredAt: now, ignoredById: actorId, status: "ignored", matchedPaise: 0 } });
      const note = [BANK_IGNORE_LABELS[input.reason], input.note, `bulk: unmatched before ${shortDay(input.before)}`].filter(Boolean).join(" · ");
      await tx.salesEvent.createMany({ data: ok.map((id) => ({ entityType: "bank_line", entityId: id, actorId, action: "ignored", toStatus: "ignored", note })) });
      return ok.length;
    });
  }
  return { ignored };
}

// ── Rematch ───────────────────────────────────────────────────────────────────────

const running = new Map<CompanyKey, { promise: Promise<RematchResult>; again: boolean }>();
type RematchResult = { checked: number; autoLinked: number; suggested: number; sure: number; unmatched: number };

/** Re-run the matcher for a company's open credits. One run per company at a time; a call during a run queues one more. */
export function rematchCompany(company: CompanyKey, actorId: string): Promise<RematchResult> {
  const cur = running.get(company);
  if (cur) { cur.again = true; return cur.promise; }
  const entry = { promise: Promise.resolve() as unknown as Promise<RematchResult>, again: false };
  entry.promise = (async () => {
    try {
      let r = await rematchOnce(company, actorId);
      while (entry.again) { entry.again = false; r = await rematchOnce(company, actorId); }
      return r;
    } finally {
      running.delete(company);
    }
  })();
  running.set(company, entry);
  return entry.promise;
}

const LINE_CHUNK = 1000;
const MAX_CHUNKS = 30; // ≤ 30,000 open credits per run — years of statements (owner: from 2023)

async function loadContext(company: CompanyKey) {
  const other = (company === "dspl" ? "dmpl" : "dspl") as CompanyKey;
  const [mine, theirs] = await Promise.all([getSellerOrDefaults(company), getSellerOrDefaults(other)]);
  const namesOf = (c: CompanyKey, p: { legalName?: string | null; tradeName?: string | null }) => [SALES_COMPANIES[c].name, SALES_COMPANIES[c].short, p.legalName, p.tradeName].filter((x): x is string => !!x);
  const ownNames = [...namesOf(company, mine), ...namesOf(other, theirs)];
  const invRows = await prisma.$queryRaw<Array<{ id: string; number: string; kind: string; client_id: string; issue_date: Date; due_date: Date | null; taxable_paise: number; total_paise: number; paid_paise: number; tds_paise: number; credited_paise: number; credited_taxable: number }>>`
    SELECT i.id, i.number, i.kind, i.client_id, i.issue_date, i.due_date, i.taxable_paise, i.total_paise, i.paid_paise, i.tds_paise, i.credited_paise,
           COALESCE((SELECT SUM(cn.taxable_paise) FROM sales_credit_notes cn WHERE cn.invoice_id = i.id AND cn.status = 'issued'), 0)::int AS credited_taxable
    FROM sales_invoices i
    WHERE i.company_key = ${company} AND i.status = 'issued' AND i.number IS NOT NULL AND i.total_paise - i.paid_paise - i.tds_paise - i.credited_paise > 0
    ORDER BY i.due_date NULLS LAST, i.issue_date, i.number LIMIT 2000`;
  if (invRows.length === 2000) console.warn(`[sales] bank rematch: ${company} has 2000+ open invoices — the oldest are not matched`);
  const invoices: OpenInvoice[] = invRows.map((i) => ({
    id: i.id, number: i.number, kind: i.kind === "proforma" ? "proforma" : "tax_invoice", clientId: i.client_id,
    issueDate: dateToDay(i.issue_date)!, dueDate: dateToDay(i.due_date), totalPaise: i.total_paise, taxablePaise: i.taxable_paise,
    creditedPaise: i.credited_paise, creditedTaxablePaise: i.credited_taxable, tdsSoFarPaise: i.tds_paise,
    balancePaise: i.total_paise - i.paid_paise - i.tds_paise - i.credited_paise,
  }));
  const clientRows = await prisma.$queryRaw<Array<{ id: string; company_name: string; legal_name: string | null; gstin: string | null; pan: string | null }>>`
    SELECT c.id, c.company_name, b.legal_name, b.gstin, b.pan FROM clients c LEFT JOIN client_billing_profiles b ON b.client_id = c.id LIMIT 5000`;
  const since = plusDays(todayIST(), -730);
  const past = await prisma.$queryRaw<Array<{ client_id: string; number: string; paid_on: Date; tds_rate_bp: number | null; amount_paise: number; tds_paise: number; taxable_paise: number; total_paise: number }>>`
    SELECT p.client_id, p.number, p.paid_on, p.tds_rate_bp, a.amount_paise, a.tds_paise, i.taxable_paise, i.total_paise
    FROM sales_payment_allocations a
    JOIN sales_payments p ON p.id = a.payment_id AND p.status = 'recorded'
    JOIN sales_invoices i ON i.id = a.invoice_id
    WHERE a.tds_paise > 0 AND i.total_paise > 0 AND p.paid_on >= ${since}::date
    ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 5000`;
  const pastTds = new Map<string, ClientInfo["pastTds"]>();
  const tally = new Map<string, Map<string, { n: number; first: number; rateBp: number; base: "taxable" | "gross"; receipt: string }>>();
  const ratesBp = TDS_RATES.map((r) => r.rateBp);
  past.forEach((row, idx) => {
    const share = (row.amount_paise + row.tds_paise) / row.total_paise;
    const base = Math.round(row.taxable_paise * share);
    let rateBp: number | null = null;
    let kind: "taxable" | "gross" = "taxable";
    if (row.tds_rate_bp) rateBp = row.tds_rate_bp;
    else if ((rateBp = nearestRate(row.tds_paise, base, ratesBp)) !== null) kind = "taxable";
    else if ((rateBp = nearestRate(row.tds_paise, row.amount_paise + row.tds_paise, ratesBp)) !== null) kind = "gross";
    else if (base > 0) {
      const custom = Math.round((row.tds_paise * 10000) / base / 5) * 5;
      if (custom >= 1 && custom <= 3000) rateBp = custom;
    }
    if (!rateBp) return;
    const m = tally.get(row.client_id) ?? new Map();
    const key = `${rateBp}|${kind}`;
    const e = m.get(key) ?? { n: 0, first: idx, rateBp, base: kind, receipt: row.number };
    e.n++;
    m.set(key, e);
    tally.set(row.client_id, m);
  });
  for (const [cid, m] of tally) {
    const best = [...m.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
    pastTds.set(cid, { rateBp: best.rateBp, base: best.base, receiptNumber: best.receipt });
  }
  const clients: ClientInfo[] = clientRows.map((c) => ({
    id: c.id, names: [c.company_name, c.legal_name].filter((x): x is string => !!x), gstin: c.gstin, pan: c.pan, pastTds: pastTds.get(c.id) ?? null,
  }));
  const fpRows = await prisma.$queryRaw<Array<{ narration: string; utr: string | null; client_id: string }>>`
    SELECT l.narration, l.utr, p.client_id FROM sales_bank_lines l JOIN sales_payments p ON p.bank_line_id = l.id AND p.status = 'recorded'
    WHERE l.company_key = ${company} ORDER BY l.txn_date DESC LIMIT 3000`;
  const fingerprints = fpRows.flatMap((r) => fingerprintTokens(r.narration, r.utr).map((token) => ({ token, clientId: r.client_id })));
  return { ownNames, otherCompanyNames: namesOf(other, theirs), invoices, clients, fingerprints };
}

const sigOf = (r: MatchResult) => createHash("sha1").update(JSON.stringify({
  c: r.candidates.map((c) => [c.codes, c.clientId, c.amountPaise, c.tdsPaise, c.score, c.confidence, c.allocations.map((a) => [a.invoiceId, a.amountPaise, a.tdsPaise, a.balancePaise])]),
  a: r.autoLink, rc: r.receiptCandidates.map((x) => x.paymentId), k: r.conflict, h: r.ignoreHint, n: r.note,
})).digest("hex");

async function rematchOnce(company: CompanyKey, actorId: string): Promise<RematchResult> {
  const base = await loadContext(company);
  const out: RematchResult = { checked: 0, autoLinked: 0, suggested: 0, sure: 0, unmatched: 0 };
  let cursor: { txnDate: Date; rowNo: number; id: string } | null = null;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    // Index-backed: (company_key, status, txn_date), newest first, keyset-paginated.
    const rows: Array<{ id: string; txnDate: Date; rowNo: number; creditPaise: bigint; matchedPaise: bigint; narration: string; reference: string | null; utr: string | null; possibleDuplicate: boolean; suggestion: Prisma.JsonValue }> = await prisma.salesBankLine.findMany({
      where: {
        companyKey: company, creditPaise: { gt: 0 }, ignoredAt: null, status: { in: OPEN_STATUSES },
        ...(cursor ? { OR: [{ txnDate: { lt: cursor.txnDate } }, { txnDate: cursor.txnDate, rowNo: { lt: cursor.rowNo } }, { txnDate: cursor.txnDate, rowNo: cursor.rowNo, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ txnDate: "desc" }, { rowNo: "desc" }, { id: "desc" }],
      take: LINE_CHUNK,
      select: { id: true, txnDate: true, rowNo: true, creditPaise: true, matchedPaise: true, narration: true, reference: true, utr: true, possibleDuplicate: true, suggestion: true },
    });
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { txnDate: last.txnDate, rowNo: last.rowNo, id: last.id };
    const days = rows.map((r) => dateToDay(r.txnDate)!).sort();
    const recRows = await prisma.salesPayment.findMany({
      where: { companyKey: company, status: "recorded", bankLineId: null, mode: { not: "razorpay" }, paidOn: { gte: dayToDate(plusDays(days[0], -60)), lte: dayToDate(plusDays(days[days.length - 1], 7)) } },
      take: 2000, select: { id: true, number: true, clientId: true, amountPaise: true, paidOn: true, reference: true, mode: true },
    });
    // A receipt a person detached from a bank line is never auto-linked again (only offered).
    const detached = recRows.length
      ? new Set((await prisma.salesEvent.findMany({ where: { entityType: "payment", action: "bank_unlinked", entityId: { in: recRows.map((p) => p.id) } }, select: { entityId: true } })).map((e) => e.entityId))
      : new Set<string>();
    const receipts: UnlinkedReceipt[] = recRows.map((p) => ({
      id: p.id, number: p.number, clientId: p.clientId, amountPaise: p.amountPaise, paidOn: dateToDay(p.paidOn)!, reference: p.reference, mode: p.mode,
      imported: p.number.startsWith("SW-"), manualOnly: detached.has(p.id),
    }));
    const lines: MatchLine[] = rows.map((r) => ({
      id: r.id, txnDate: dateToDay(r.txnDate)!, creditPaise: n(r.creditPaise), remainingPaise: Math.max(0, n(r.creditPaise) - n(r.matchedPaise)),
      narration: r.narration, reference: r.reference, utr: r.utr, possibleDuplicate: r.possibleDuplicate, rowNo: r.rowNo,
    }));
    const ctx: MatchContext = { ...base, receipts };
    const results = matchCredits(lines, ctx);
    for (const r of rows) {
      const res = results[r.id];
      if (!res) continue;
      out.checked++;
      const sig = sigOf(res);
      const old = r.suggestion as { sig?: string } | null;
      if (old?.sig !== sig) {
        await prisma.$transaction(async (tx) => {
          const got = await tx.$queryRaw<Array<{ id: string; ignored_at: Date | null }>>`SELECT id, ignored_at FROM sales_bank_lines WHERE id = ${r.id} FOR UPDATE SKIP LOCKED`;
          if (!got.length || got[0].ignored_at) return;
          await tx.salesBankLine.update({ where: { id: r.id }, data: { suggestion: { ...res, sig } as unknown as Prisma.InputJsonValue, bestScore: res.bestScore, confidence: res.confidence, suggestedAt: new Date() } });
          await refreshBankLine(tx, r.id);
        });
      }
      if (res.autoLink) {
        if (await autoLink(r.id, res.autoLink, company)) out.autoLinked++;
      } else if (res.confidence === "high") { out.sure++; out.suggested++; }
      else if (res.confidence === "medium") out.suggested++;
      else out.unmatched++;
    }
    if (rows.length < LINE_CHUNK) break;
  }
  void actorId;
  return out;
}

async function autoLink(lineId: string, link: NonNullable<MatchResult["autoLink"]>, company: CompanyKey): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const got = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_bank_lines WHERE id = ${lineId} FOR UPDATE SKIP LOCKED`;
    if (!got.length) return false;
    const line = await tx.salesBankLine.findUnique({ where: { id: lineId }, include: { bankAccount: true, statement: { select: { fileName: true } } } });
    if (!line || line.ignoredAt || line.companyKey !== company) return false;
    const matched = await liveMatched(tx, lineId);
    const p = await lockPayment(tx, link.paymentId);
    if (p.status !== "recorded" || p.bankLineId || p.companyKey !== company || p.mode === "razorpay") return false;
    if (matched + p.amountPaise > n(line.creditPaise) + 100) return false;
    await tx.salesPayment.update({ where: { id: p.id }, data: { bankLineId: lineId } });
    await refreshBankLine(tx, lineId);
    const after = await tx.salesBankLine.findUniqueOrThrow({ where: { id: lineId }, select: { status: true } });
    await logSalesEvent(tx, { entityType: "bank_line", entityId: lineId, actorId: SYSTEM_ACTOR, action: "auto_linked", fromStatus: line.status, toStatus: after.status, note: `${p.number} · ${link.why}` });
    await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId: SYSTEM_ACTOR, action: "bank_matched", note: `${accountName(line.bankAccount)} · ${shortDay(dateToDay(line.txnDate)!)} · row ${line.rowNo} of ${line.statement.fileName}` });
    return true;
  }, { maxWait: 10_000 });
}

// ── Summary (the /bank stats and the dashboard tile) ─────────────────────────────

export type BankSummary = Awaited<ReturnType<typeof bankSummary>>;
export async function bankSummary(company: CompanyKey) {
  const today = todayIST();
  const [y, m] = today.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const [s] = await prisma.$queryRaw<Array<{ month_count: number; month_paise: bigint; open_count: number; open_paise: bigint; review_count: number; sure_count: number }>>`
    SELECT
      count(*) FILTER (WHERE txn_date >= ${from}::date AND txn_date < ${to}::date)::int AS month_count,
      COALESCE(sum(credit_paise - matched_paise) FILTER (WHERE txn_date >= ${from}::date AND txn_date < ${to}::date), 0)::bigint AS month_paise,
      count(*)::int AS open_count,
      COALESCE(sum(credit_paise - matched_paise), 0)::bigint AS open_paise,
      count(*) FILTER (WHERE status = 'suggested')::int AS review_count,
      count(*) FILTER (WHERE status = 'suggested' AND confidence = 'high')::int AS sure_count
    FROM sales_bank_lines
    WHERE company_key = ${company} AND credit_paise > 0 AND status IN ('unmatched','suggested','partly_matched')`;
  const accounts = await prisma.$queryRaw<Array<{ id: string; label: string; last4: string; last_to: Date | null }>>`
    SELECT a.id, a.label, right(a.account_number, 4) AS last4, MAX(s.period_to) AS last_to
    FROM sales_bank_accounts a LEFT JOIN sales_bank_statements s ON s.bank_account_id = a.id
    WHERE a.company_key = ${company} AND a.status = 'active' GROUP BY a.id ORDER BY a.label`;
  return {
    unmatchedMonthCount: s.month_count, unmatchedMonthPaise: n(s.month_paise), openCount: s.open_count, openPaise: n(s.open_paise),
    reviewCount: s.review_count, sureCount: s.sure_count,
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, last4: a.last4, lastStatementTo: dateToDay(a.last_to) })),
  };
}

/** The dashboard tile: null when the company has no bank account (two small queries). */
export async function bankSummaryOrNullForDashboard(company: CompanyKey): Promise<BankSummary | null> {
  const any = await prisma.salesBankAccount.count({ where: { companyKey: company } });
  return any ? bankSummary(company) : null;
}

export { plusDays as bankPlusDays };
