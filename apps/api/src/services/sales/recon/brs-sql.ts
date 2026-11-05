import { Prisma } from "@dashmani/db";
import { dayAdd, last4, type CompanyKey } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { dateToDay, dayToDate, toSafeNumber, type Tx } from "../common";
import { getSellerOrDefaults } from "../settings.service";
import { accountName, monthBounds, type BrsAccountIn, type BrsBookReceipt, type BrsInput, type BrsLineIn, type BrsOpenCredit, type BrsReceipt, type BrsStatementIn } from "./brs";

// The BRS reads (spec-reconcile §5.4.1, §5.4.6): bounded, company-scoped, read-only. Every BIGINT
// goes through toSafeNumber. Nothing here locks or writes a bank line, receipt or invoice.

export const BRS_MAX_LINES = 20_000;
type Db = Tx;

export interface AccountRow { id: string; companyKey: string; label: string; bank: string; accountNumber: string; ifsc: string | null; matchFrom: Date | null; status: string; createdAt: Date }

export const accountIn = (a: AccountRow): BrsAccountIn => ({ id: a.id, label: a.label, bank: a.bank, last4: last4(a.accountNumber), ifsc: a.ifsc, matchFrom: dateToDay(a.matchFrom) });

/** §5.4.2: the only active account; else the one printed on invoices; else the oldest. */
export async function defaultReceivingAccount(db: Db, company: CompanyKey): Promise<{ account: AccountRow; why: "only" | "printed_on_invoices" | "oldest" } | null> {
  const active = await db.salesBankAccount.findMany({ where: { companyKey: company, status: "active" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!active.length) return null;
  if (active.length === 1) return { account: active[0], why: "only" };
  const printed = ((await getSellerOrDefaults(company)).accountNumber ?? "").replace(/\D/g, "");
  const hit = printed ? active.find((a) => a.accountNumber === printed) : undefined;
  if (hit) return { account: hit, why: "printed_on_invoices" };
  return { account: active[0], why: "oldest" };
}

type LineRow = Prisma.SalesBankLineGetPayload<{ include: { statement: { select: { fileName: true } }; payments: { select: { id: true; number: true; paidOn: true; mode: true; amountPaise: true; status: true; client: { select: { companyName: true } } } } } }>;

const receiptOf = (p: { id: string; number: string; paidOn: Date; mode: string; amountPaise: number; client: { companyName: string } }): BrsReceipt =>
  ({ id: p.id, number: p.number, paidOn: dateToDay(p.paidOn)!, clientName: p.client.companyName, mode: p.mode, amountPaise: p.amountPaise });

function lineIn(l: LineRow, names: Map<string, string>): BrsLineIn {
  return {
    id: l.id, statementId: l.statementId, fileName: l.statement.fileName, rowNo: l.rowNo, txnDate: dateToDay(l.txnDate)!,
    narration: l.narration, reference: l.reference, utr: l.utr,
    creditPaise: toSafeNumber(l.creditPaise), debitPaise: toSafeNumber(l.debitPaise), balancePaise: l.balancePaise === null ? null : toSafeNumber(l.balancePaise),
    possibleDuplicate: l.possibleDuplicate, confidence: l.confidence, suggestion: l.suggestion,
    ignoreReason: l.ignoreReason, ignoreNote: l.ignoreNote, ignoredAt: l.ignoredAt ? l.ignoredAt.toISOString() : null, ignoredByName: l.ignoredById ? names.get(l.ignoredById) ?? null : null,
    receipts: l.payments.filter((p) => p.status === "recorded").map(receiptOf),
  };
}
const lineInclude = {
  statement: { select: { fileName: true } },
  payments: { select: { id: true, number: true, paidOn: true, mode: true, amountPaise: true, status: true, client: { select: { companyName: true } } } },
} satisfies Prisma.SalesBankLineInclude;

async function namesOf(db: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter(Boolean) as string[])];
  if (!set.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: set } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Every input of one month (§5.4.1). Throws 422 BRS_TOO_BIG past 20,000 lines. */
export async function loadBrsInput(db: Db, o: { company: CompanyKey; account: AccountRow; defaultAccountId: string | null; month: string; today: string; seeDebits: boolean; typedClosingPaise?: number | null }): Promise<BrsInput> {
  const { from, to, next, label } = monthBounds(o.month);
  const acc = o.account;
  const range = { gte: dayToDate(from), lt: dayToDate(next) };
  const n = await db.salesBankLine.count({ where: { bankAccountId: acc.id, txnDate: range } });
  if (n > BRS_MAX_LINES) throw new AppError(422, "BRS_TOO_BIG", `${label.split(" ")[0]} has more than 20,000 transactions on this account — upload the statement by fortnight.`);

  const rows = await db.salesBankLine.findMany({ where: { bankAccountId: acc.id, txnDate: range }, include: lineInclude });
  const prevDay = await db.salesBankLine.findFirst({ where: { bankAccountId: acc.id, txnDate: { lt: dayToDate(from) } }, orderBy: { txnDate: "desc" }, select: { txnDate: true } });
  const prevRows = prevDay ? await db.salesBankLine.findMany({ where: { bankAccountId: acc.id, txnDate: prevDay.txnDate }, take: 2_000, include: lineInclude }) : [];
  const names = await namesOf(db, [...rows, ...prevRows].map((l) => l.ignoredById));

  const stRows = await db.salesBankStatement.findMany({
    where: { bankAccountId: acc.id, periodTo: { gte: dayToDate(dayAdd(from, -1)) }, periodFrom: { lte: dayToDate(next) } },
    select: { id: true, fileName: true, periodFrom: true, periodTo: true, openingBalancePaise: true, closingBalancePaise: true },
  });
  const extra = [...new Set([...rows, ...prevRows].map((l) => l.statementId))].filter((id) => !stRows.some((s) => s.id === id));
  const allSt = extra.length
    ? [...stRows, ...(await db.salesBankStatement.findMany({ where: { id: { in: extra } }, select: { id: true, fileName: true, periodFrom: true, periodTo: true, openingBalancePaise: true, closingBalancePaise: true } }))]
    : stRows;
  const dirs = allSt.length ? await db.$queryRaw<Array<{ statement_id: string; first_day: Date | null; last_day: Date | null }>>`
    SELECT s.id AS statement_id,
      (SELECT l.txn_date FROM sales_bank_lines l WHERE l.statement_id = s.id ORDER BY l.row_no ASC LIMIT 1) AS first_day,
      (SELECT l.txn_date FROM sales_bank_lines l WHERE l.statement_id = s.id ORDER BY l.row_no DESC LIMIT 1) AS last_day
    FROM sales_bank_statements s WHERE s.id IN (${Prisma.join(allSt.map((s) => s.id))})` : [];
  const dir = new Map(dirs.map((d) => [d.statement_id, d]));
  const statements: BrsStatementIn[] = allSt.map((s) => ({
    id: s.id, fileName: s.fileName, periodFrom: dateToDay(s.periodFrom)!, periodTo: dateToDay(s.periodTo)!,
    openingPaise: s.openingBalancePaise === null ? null : toSafeNumber(s.openingBalancePaise), closingPaise: s.closingBalancePaise === null ? null : toSafeNumber(s.closingBalancePaise),
    firstRowDay: dateToDay(dir.get(s.id)?.first_day ?? null), lastRowDay: dateToDay(dir.get(s.id)?.last_day ?? null),
  }));
  const cov = await db.salesBankStatement.aggregate({ where: { bankAccountId: acc.id }, _max: { periodTo: true } });

  const payRows = await db.salesPayment.findMany({
    where: { companyKey: o.company, status: "recorded", paidOn: range },
    select: { id: true, number: true, paidOn: true, mode: true, amountPaise: true, bankLineId: true, client: { select: { companyName: true } }, bankLine: { select: { bankAccountId: true, txnDate: true, ignoreReason: true } } },
    take: 50_000,
  });
  const books: BrsBookReceipt[] = payRows.map((p) => ({
    ...receiptOf(p), bankLineId: p.bankLineId, lineAccountId: p.bankLine?.bankAccountId ?? null, lineDay: dateToDay(p.bankLine?.txnDate ?? null), lineIsDuplicate: p.bankLine?.ignoreReason === "duplicate",
  }));

  const openRows = await db.salesBankLine.findMany({
    where: { companyKey: o.company, creditPaise: { gt: 0 }, ignoredAt: null, txnDate: { gte: dayToDate(dayAdd(from, -7)), lte: dayToDate(dayAdd(to, 7)) } },
    select: { id: true, bankAccountId: true, txnDate: true, rowNo: true, creditPaise: true, statement: { select: { fileName: true } }, bankAccount: { select: { label: true, accountNumber: true } }, payments: { where: { status: "recorded" }, select: { amountPaise: true } } },
    take: BRS_MAX_LINES,
  });
  const openCredits: BrsOpenCredit[] = openRows
    .map((l) => ({ lineId: l.id, accountId: l.bankAccountId, accountName: accountName({ label: l.bankAccount.label, last4: last4(l.bankAccount.accountNumber) }), txnDate: dateToDay(l.txnDate)!, rowNo: l.rowNo, fileName: l.statement.fileName,
      remainingPaise: toSafeNumber(l.creditPaise) - l.payments.reduce((s, p) => s + p.amountPaise, 0) }))
    .filter((c) => c.remainingPaise > 100);

  const unRows = await db.salesPayment.findMany({
    where: { companyKey: o.company, status: "recorded", bankLineId: null, mode: { not: "razorpay" }, paidOn: { gte: dayToDate(dayAdd(from, -31)), lte: dayToDate(dayAdd(to, 7)) } },
    select: { id: true, number: true, paidOn: true, mode: true, amountPaise: true, client: { select: { companyName: true } } },
    take: 50_000,
  });
  const refunds = await db.salesRefund.findMany({
    where: { status: "issued", payment: { companyKey: o.company }, refundedOn: { gte: dayToDate(dayAdd(from, -7)), lte: dayToDate(dayAdd(to, 7)) } },
    select: { id: true, number: true },
  });

  return {
    company: o.company, account: accountIn(acc), defaultAccountId: o.defaultAccountId, month: o.month, today: o.today,
    lines: rows.map((l) => lineIn(l, names)), statements, books, openCredits, unlinked: unRows.map(receiptOf), refunds,
    coverageEnd: dateToDay(cov._max.periodTo), previousDayLines: prevRows.map((l) => lineIn(l, names)),
    typedClosingPaise: o.typedClosingPaise ?? null, seeDebits: o.seeDebits,
  };
}

/**
 * §5.4.6: md5 over everything that moves a figure or an item's group, for every month in
 * [firstMonth, lastMonth] in ONE statement. Not suggestions, reasons, statuses or notes; not where
 * a not-credited receipt was later credited.
 */
export async function brsFingerprints(db: Db, o: { accountId: string; company: string; firstMonth: string; lastMonth: string; defaultAccountId: string | null }): Promise<Map<string, string>> {
  const start = `${o.firstMonth}-01`;
  const end = monthBounds(o.lastMonth).next;
  const def = o.defaultAccountId ?? "";
  const rows = await db.$queryRaw<Array<{ month: string; fingerprint: string }>>`
    WITH months AS (SELECT to_char(d, 'YYYY-MM') AS month FROM generate_series(${start}::date, ${end}::date - 1, interval '1 month') d),
    lp AS (SELECT p.bank_line_id, string_agg(p.id || '=' || p.amount_paise, ',' ORDER BY p.id) AS pairs
           FROM sales_payments p JOIN sales_bank_lines l ON l.id = p.bank_line_id
           WHERE p.status = 'recorded' AND l.bank_account_id = ${o.accountId} AND l.txn_date >= ${start}::date AND l.txn_date < ${end}::date
           GROUP BY p.bank_line_id),
    l AS (SELECT to_char(l.txn_date, 'YYYY-MM') AS month,
                 md5(string_agg(concat_ws(':', l.id, l.txn_date, l.credit_paise, l.debit_paise, COALESCE(l.balance_paise::text, '-'),
                     COALESCE(l.ignore_reason, '-'), COALESCE(lp.pairs, '-')), ',' ORDER BY l.id)) AS h
          FROM sales_bank_lines l LEFT JOIN lp ON lp.bank_line_id = l.id
          WHERE l.bank_account_id = ${o.accountId} AND l.txn_date >= ${start}::date AND l.txn_date < ${end}::date GROUP BY 1),
    r AS (SELECT to_char(p.paid_on, 'YYYY-MM') AS month,
                 md5(string_agg(concat_ws(':', p.id, p.amount_paise, p.mode,
                     COALESCE(pl.bank_account_id = ${o.accountId} AND date_trunc('month', pl.txn_date) = date_trunc('month', p.paid_on), false)::text),
                     ',' ORDER BY p.id)) AS h
          FROM sales_payments p LEFT JOIN sales_bank_lines pl ON pl.id = p.bank_line_id
          WHERE p.company_key = ${o.company} AND p.status = 'recorded' AND p.paid_on >= ${start}::date AND p.paid_on < ${end}::date
            AND (pl.bank_account_id = ${o.accountId}
                 OR (p.bank_line_id IS NULL AND p.mode IN ('bank_transfer','upi','cheque','other') AND ${def}::text = ${o.accountId}::text))
          GROUP BY 1),
    s AS (SELECT m.month, md5(COALESCE(string_agg(concat_ws(':', st.id, st.period_from, st.period_to,
                 COALESCE(st.opening_balance_paise::text, '-'), COALESCE(st.closing_balance_paise::text, '-')), ',' ORDER BY st.id), '')) AS h
          FROM months m LEFT JOIN sales_bank_statements st ON st.bank_account_id = ${o.accountId}
            AND st.period_from <= (to_date(m.month, 'YYYY-MM') + interval '1 month')::date
            AND st.period_to >= (to_date(m.month, 'YYYY-MM') - 1)
          GROUP BY m.month)
    SELECT months.month, md5(concat_ws('|', 'v1', COALESCE(l.h, '-'), COALESCE(r.h, '-'), s.h)) AS fingerprint
    FROM months JOIN s USING (month) LEFT JOIN l USING (month) LEFT JOIN r USING (month) ORDER BY 1`;
  return new Map(rows.map((r) => [r.month, r.fingerprint]));
}

/** Credits / withdrawals / line count per month (duplicates excluded from the money). */
export async function brsMonthTotals(db: Db, accountId: string): Promise<Map<string, { creditsPaise: number; debitsPaise: number; lineCount: number }>> {
  const rows = await db.$queryRaw<Array<{ month: string; credits: bigint | null; debits: bigint | null; n: bigint }>>`
    SELECT to_char(txn_date, 'YYYY-MM') AS month,
      SUM(CASE WHEN ignore_reason IS DISTINCT FROM 'duplicate' THEN credit_paise ELSE 0 END)::bigint AS credits,
      SUM(CASE WHEN ignore_reason IS DISTINCT FROM 'duplicate' THEN debit_paise ELSE 0 END)::bigint AS debits,
      COUNT(*)::bigint AS n
    FROM sales_bank_lines WHERE bank_account_id = ${accountId} GROUP BY 1`;
  return new Map(rows.map((r) => [r.month, { creditsPaise: toSafeNumber(r.credits), debitsPaise: toSafeNumber(r.debits), lineCount: toSafeNumber(r.n) }]));
}
