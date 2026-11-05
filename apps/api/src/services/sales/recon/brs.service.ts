import { prisma, Prisma } from "@dashmani/db";
import { SALES_COMPANIES, dayAdd, isCompanyKey, reconDay, reconInr, type BrsReconcileInput, type BrsReopenInput, type CompanyKey } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { logSalesEvent, toSafeNumber, type Tx } from "../common";
import { getSellerOrDefaults } from "../settings.service";
import { accountName, brsChanges, brsState, buildBrs, coverageOf, monthBounds, monthOf, type BrsCore, type BrsItem, type BrsState } from "./brs";
import { accountIn, brsFingerprints, brsMonthTotals, defaultReceivingAccount, defaultResolver, loadBrsInput, type AccountRow } from "./brs-sql";
import { renderBrsPdf } from "./recon-pdf";
import { brsCsv as buildBrsCsv } from "./recon-csv";

// The Bank tab of /reconcile (spec-reconcile §5.4, §6.6, PR 6). Reads run in ONE read-only
// REPEATABLE READ snapshot so `ties` cannot fail from a race; sign-offs are immutable versions
// (only the supersede columns ever change), one active per (account, month) through active_key.
// Nothing here writes a bank line, a receipt or any money table, and no bank file is changed.

const RO = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 15_000 } as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type SignoffRow = Prisma.SalesBrsSignoffGetPayload<object>;

export type BrsView = BrsCore & {
  accounts: Array<{ id: string; label: string; last4: string; isDefault: boolean }>;
  defaultAccount: { id: string; why: "only" | "printed_on_invoices" | "oldest" } | null;
  fingerprint: string;
  state: BrsState;
  signoff: null | { id: string; version: number; reconciledAt: string; reconciledByName: string; note: string | null; accepted: string[]; balanceSource: string; closingPaise: number; booksPaise: number; openItemsPaise: number };
  versions: Array<{ version: number; reconciledAt: string; reconciledByName: string; supersedeKind: string | null; supersededAt: string | null; supersedeReason: string | null; supersededByName: string | null }>;
  reopened: null | { byName: string; at: string; reason: string | null };
  changes: null | { added: BrsItem[]; removed: BrsItem[]; figures: Array<{ key: string; frozenPaise: number | null; livePaise: number | null }>; newLines: Array<{ statementId: string; fileName: string; uploadedByName: string; uploadedAt: string; lines: number }> };
};

type MonthDefault = { id: string; why: "only" | "printed_on_invoices" | "oldest" } | null;
/** The default receiving account a month is judged with: the one its active sign-off froze, else the one as of that month. */
function frozenDefault(active: SignoffRow | null | undefined): MonthDefault | undefined {
  const snap = active?.snapshot as { defaultAccount?: MonthDefault } | null | undefined;
  return snap && "defaultAccount" in snap ? snap.defaultAccount ?? null : undefined;
}
async function monthDefault(db: Tx, company: CompanyKey, month: string, active: SignoffRow | null): Promise<MonthDefault> {
  const f = frozenDefault(active);
  if (f !== undefined) return f;
  const d = await defaultReceivingAccount(db, company, month);
  return d ? { id: d.account.id, why: d.why } : null;
}
const defaultMonthsFor = (accountId: string, month: string, def: MonthDefault) => (def?.id === accountId ? [month] : []);

/** The month whose end has passed most recently. */
export const lastClosedMonth = (today: string) => monthOf(dayAdd(`${today.slice(0, 7)}-01`, -1));

async function names(db: Tx, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter(Boolean) as string[])];
  if (!set.length) return new Map();
  return new Map((await db.user.findMany({ where: { id: { in: set } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

/** The account a request is about: its own company always wins (409 COMPANY_MISMATCH on another). */
async function resolveAccount(db: Tx, company: CompanyKey | undefined, accountId: string | undefined, fallbackCompany: CompanyKey) {
  if (accountId) {
    const a = await db.salesBankAccount.findUnique({ where: { id: accountId } });
    if (!a) throw new AppError(404, "NOT_FOUND", "Bank account not found");
    if (company && a.companyKey !== company) {
      const other = isCompanyKey(a.companyKey) ? SALES_COMPANIES[a.companyKey].name : "the other company";
      throw new AppError(409, "COMPANY_MISMATCH", `This belongs to ${other} — switch company at the top.`);
    }
    const c = a.companyKey as CompanyKey;
    return { account: a as AccountRow, company: c, def: await defaultReceivingAccount(db, c) };
  }
  const c = company ?? fallbackCompany;
  const def = await defaultReceivingAccount(db, c);
  return { account: def?.account ?? null, company: c, def };
}

async function accountsList(db: Tx, company: CompanyKey, defaultId: string | null) {
  const rows = await db.salesBankAccount.findMany({ where: { companyKey: company, status: "active" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((a) => ({ id: a.id, label: a.label, last4: accountIn(a).last4, isDefault: a.id === defaultId }));
}

// ─── Months (route 21) ───────────────────────────────────────────────────────────────────────

export async function listBrsMonths(companyQ: CompanyKey | undefined, fallback: CompanyKey, accountId: string | undefined, today: string) {
  return prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const { account, company, def } = await resolveAccount(db, companyQ, accountId, fallback);
    const accounts = await accountsList(db, company, def?.account.id ?? null);
    if (!account) return { company, account: null, accounts, defaultAccount: null, months: [] };
    const statements = await db.salesBankStatement.findMany({ where: { bankAccountId: account.id }, select: { id: true, fileName: true, periodFrom: true, periodTo: true, openingBalancePaise: true, closingBalancePaise: true } });
    const base = { company, account: accountIn(account), accounts, defaultAccount: def ? { id: def.account.id, why: def.why } : null };
    if (!statements.length) return { ...base, months: [] };
    const st = statements.map((s) => ({ id: s.id, fileName: s.fileName, periodFrom: s.periodFrom.toISOString().slice(0, 10), periodTo: s.periodTo.toISOString().slice(0, 10),
      openingPaise: s.openingBalancePaise === null ? null : toSafeNumber(s.openingBalancePaise), closingPaise: s.closingBalancePaise === null ? null : toSafeNumber(s.closingBalancePaise), firstRowDay: null, lastRowDay: null }));
    const firstSt = st.reduce((m, s) => (s.periodFrom < m ? s.periodFrom : m), st[0].periodFrom);
    const mf = account.matchFrom ? account.matchFrom.toISOString().slice(0, 10) : null;
    let first = monthOf(mf && mf > firstSt ? mf : firstSt);
    const last = monthOf(today);
    if (first > last) first = last;
    const active = await db.salesBrsSignoff.findMany({ where: { bankAccountId: account.id, activeKey: { not: null } } });
    const activeBy = new Map(active.map((s) => [s.month, s]));
    // Each month's default receiving account: frozen by its sign-off, else as of that month.
    const resolve = await defaultResolver(db, company);
    const defaultMonths: string[] = [];
    for (let m = first; m <= last; m = monthOf(monthBounds(m).next)) {
      const f = frozenDefault(activeBy.get(m));
      const id = f !== undefined ? f?.id ?? null : resolve(m)?.account.id ?? null;
      if (id === account.id) defaultMonths.push(m);
    }
    const fps = await brsFingerprints(db, { accountId: account.id, company, firstMonth: first, lastMonth: last, defaultMonths });
    const totals = await brsMonthTotals(db, account.id);
    const who = await names(db, active.map((s) => s.reconciledById));
    const months = [...fps.keys()].sort().reverse().map((m) => {
      const mb = monthBounds(m);
      const so = activeBy.get(m);
      const cov = coverageOf(st, mb.from, mb.to);
      const t = totals.get(m) ?? { creditsPaise: 0, debitsPaise: 0, lineCount: 0 };
      const covered = cov.touches && cov.gaps.length ? `Statement covers ${coverageNote(mb.from, mb.to, cov.gaps)}` : null;
      return {
        month: m, label: mb.label, state: brsState({ monthTo: mb.to, today, activeFingerprint: so?.fingerprint ?? null, liveFingerprint: fps.get(m)! }),
        creditsPaise: t.creditsPaise, debitsPaise: t.debitsPaise, lineCount: t.lineCount,
        coverage: !cov.touches ? ("none" as const) : cov.gaps.length ? ("partial" as const) : ("complete" as const), coverageNote: covered,
        reconciledAt: so ? so.reconciledAt.toISOString() : null, reconciledByName: so ? who.get(so.reconciledById) ?? "staff" : null, version: so?.version ?? null,
      };
    });
    return { ...base, months };
  }, RO);
}

function coverageNote(from: string, to: string, gaps: Array<{ from: string; to: string }>): string {
  // The covered days, as one span when there is one gap at an end ("1–25 Oct").
  const covered: Array<{ from: string; to: string }> = [];
  let c = from;
  for (const g of gaps) { if (g.from > c) covered.push({ from: c, to: dayAdd(g.from, -1) }); c = dayAdd(g.to, 1); }
  if (c <= to) covered.push({ from: c, to });
  const f = (d: string) => reconDay(d).replace(/ \d{4}$/, "");
  return covered.map((x) => (x.from === x.to ? f(x.from) : `${Number(x.from.slice(8, 10))}–${f(x.to)}`)).join(", ") || "no day";
}

// ─── One month (route 22) ────────────────────────────────────────────────────────────────────

async function buildView(db: Tx, o: { company: CompanyKey; account: AccountRow; month: string; today: string; seeDebits: boolean; typedClosingPaise?: number | null }) {
  const signoffs = await db.salesBrsSignoff.findMany({ where: { bankAccountId: o.account.id, month: o.month }, orderBy: { version: "asc" } });
  const active = signoffs.find((s) => s.activeKey) ?? null;
  const def = await monthDefault(db, o.company, o.month, active);
  const typed = o.typedClosingPaise ?? (active && active.balanceSource === "typed" ? toSafeNumber(active.closingPaise) : null);
  const input = await loadBrsInput(db, { company: o.company, account: o.account, defaultAccountId: def?.id ?? null, month: o.month, today: o.today, seeDebits: o.seeDebits, typedClosingPaise: typed });
  const core = buildBrs(input);
  if (!core.ties) console.error(`[sales] brs did not tie ${o.account.id} ${o.month}`);
  const fp = (await brsFingerprints(db, { accountId: o.account.id, company: o.company, firstMonth: o.month, lastMonth: o.month, defaultMonths: defaultMonthsFor(o.account.id, o.month, def) })).get(o.month)!;
  return { core, fp, signoffs, active, input, def };
}

async function decorate(db: Tx, b: Awaited<ReturnType<typeof buildView>>, o: { company: CompanyKey; account: AccountRow; month: string; today: string; seeDebits: boolean }): Promise<BrsView> {
  const { core, fp, signoffs, active, def } = b;
  const mb = monthBounds(o.month);
  const who = await names(db, signoffs.flatMap((s) => [s.reconciledById, s.supersededById]));
  const state = brsState({ monthTo: mb.to, today: o.today, activeFingerprint: active?.fingerprint ?? null, liveFingerprint: fp });
  let changes: BrsView["changes"] = null;
  if (state === "changed" && active) {
    const frozen = active.snapshot as unknown as BrsCore;
    const diff = brsChanges(frozen, core);
    const fresh = await db.salesBankLine.groupBy({
      by: ["statementId"], where: { bankAccountId: o.account.id, txnDate: { gte: new Date(`${mb.from}T00:00:00Z`), lt: new Date(`${mb.next}T00:00:00Z`) }, createdAt: { gt: active.reconciledAt } }, _count: { _all: true },
    });
    const sts = fresh.length ? await db.salesBankStatement.findMany({ where: { id: { in: fresh.map((f) => f.statementId) } }, select: { id: true, fileName: true, uploadedById: true, createdAt: true } }) : [];
    const up = await names(db, sts.map((s) => s.uploadedById));
    changes = { ...diff, newLines: fresh.map((f) => { const s = sts.find((x) => x.id === f.statementId)!; return { statementId: f.statementId, fileName: s.fileName, uploadedByName: up.get(s.uploadedById) ?? "staff", uploadedAt: s.createdAt.toISOString(), lines: f._count._all }; }) };
  }
  const latest = signoffs[signoffs.length - 1];
  const reopened = !active && latest?.supersedeKind === "reopened" ? { byName: who.get(latest.supersededById ?? "") ?? "staff", at: latest.supersededAt!.toISOString(), reason: latest.supersedeReason } : null;
  return {
    ...core,
    accounts: await accountsList(db, o.company, def?.id ?? null),
    defaultAccount: def,
    fingerprint: fp, state,
    signoff: active ? {
      id: active.id, version: active.version, reconciledAt: active.reconciledAt.toISOString(), reconciledByName: who.get(active.reconciledById) ?? "staff", note: active.note,
      accepted: active.accepted as string[], balanceSource: active.balanceSource, closingPaise: toSafeNumber(active.closingPaise), booksPaise: toSafeNumber(active.booksPaise), openItemsPaise: toSafeNumber(active.openItemsPaise),
    } : null,
    versions: [...signoffs].reverse().map((s) => ({ version: s.version, reconciledAt: s.reconciledAt.toISOString(), reconciledByName: who.get(s.reconciledById) ?? "staff",
      supersedeKind: s.supersedeKind, supersededAt: s.supersededAt ? s.supersededAt.toISOString() : null, supersedeReason: s.supersedeReason, supersededByName: s.supersededById ? who.get(s.supersededById) ?? "staff" : null })),
    reopened, changes,
  };
}

function checkMonth(month: string | undefined, today: string): string {
  const m = month ?? lastClosedMonth(today);
  if (!MONTH_RE.test(m)) throw new AppError(400, "VALIDATION_ERROR", "Pick a month like 2026-10");
  return m;
}

export async function getBrs(companyQ: CompanyKey | undefined, fallback: CompanyKey, accountId: string | undefined, monthQ: string | undefined, today: string, opts: { seeDebits: boolean }): Promise<BrsView> {
  const month = checkMonth(monthQ, today);
  return prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await db.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    const { account, company } = await resolveAccount(db, companyQ, accountId, fallback);
    if (!account) throw new AppError(404, "NO_BANK_ACCOUNT", `No bank account is set up for ${SALES_COMPANIES[company].name} — an admin adds it in Settings → Bank accounts.`);
    const o = { company, account, month, today, seeDebits: opts.seeDebits };
    return decorate(db, await buildView(db, o), o);
  }, RO);
}

// ─── Reconcile / reopen (routes 23, 24) ──────────────────────────────────────────────────────

const lockKey = (accountId: string, month: string) => `brs:${accountId}:${month}`;

export async function reconcileMonth(body: BrsReconcileInput, companyQ: CompanyKey | undefined, fallback: CompanyKey, actorId: string, today: string) {
  return prisma.$transaction(async (db) => {
    const { account, company } = await resolveAccount(db, companyQ, body.accountId, fallback);
    if (!account) throw new AppError(404, "NOT_FOUND", "Bank account not found");
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(account.id, body.month)}))`;
    const active = await db.salesBrsSignoff.findFirst({ where: { bankAccountId: account.id, month: body.month, activeKey: { not: null } } });
    const def = await monthDefault(db, company, body.month, active);
    const fpArgs = { accountId: account.id, company, firstMonth: body.month, lastMonth: body.month, defaultMonths: defaultMonthsFor(account.id, body.month, def) };
    const fp1 = (await brsFingerprints(db, fpArgs)).get(body.month)!;
    const stale = new AppError(409, "BRS_CHANGED", "The statement or the receipts changed while you were looking — the page now shows the new figures; check them and mark reconciled again.");
    if (fp1 !== body.fingerprint) throw stale;
    const mb = monthBounds(body.month);
    if (mb.to >= today) throw new AppError(422, "MONTH_NOT_OVER", `${mb.label} isn't over yet — it can be reconciled from ${reconDay(mb.next)}.`);
    // A typed closing is not in the fingerprint: a corrected figure makes a new version; none sent keeps the active one's (as the page shows it).
    const activeTyped = active && active.balanceSource === "typed" ? toSafeNumber(active.closingPaise) : null;
    const retyped = body.typedClosingPaise != null && activeTyped !== null && body.typedClosingPaise !== activeTyped;
    if (active && active.fingerprint === fp1 && !retyped) return { status: 200, result: { unchanged: true, version: active.version } };

    const input = await loadBrsInput(db, { company, account, defaultAccountId: def?.id ?? null, month: body.month, today, seeDebits: true, typedClosingPaise: body.typedClosingPaise ?? activeTyped });
    const core = buildBrs(input);
    const accName = accountName({ label: account.label, last4: core.account.last4 });
    if (!core.coverage.statements.length) throw new AppError(422, "BRS_NO_STATEMENT", `No statement of ${accName} covers ${mb.label} — upload it on Bank.`);
    if (!core.ties) { console.error(`[sales] brs did not tie ${account.id} ${body.month}`); throw new AppError(500, "BRS_DID_NOT_TIE", "The figures do not add up — reconciling is refused. Tell the developers."); }
    if (core.items.some((i) => i.group === "over_matched")) throw new AppError(422, "BRS_OVER_MATCHED", "A credit carries more receipts than its amount — unlink the extra receipt on Bank first.");
    if (core.openItems.count && !body.acceptOpenItems) {
      throw new AppError(409, "BRS_OPEN_ITEMS", `${core.openItems.count} item${core.openItems.count === 1 ? "" : "s"} (${reconInr(core.openItems.paise)}) ${core.openItems.count === 1 ? "is" : "are"} still open — tick "Carry them as reconciling items" to reconcile.`);
    }
    if (core.coverage.gaps.length && !body.acceptCoverageGaps) {
      const g = core.coverage.gaps[0];
      throw new AppError(422, "BRS_COVERAGE_GAP", `No statement covers ${g.from === g.to ? reconDay(g.from) : `${reconDay(g.from)} – ${reconDay(g.to)}`} — upload it, or confirm with a note that there were no transactions.`);
    }
    if (core.balances.breaks.length && !body.acceptBreaks) throw new AppError(422, "BRS_STATEMENT_BREAK", `${core.balances.breaks[0].text} — fix it on Bank, or reconcile with a note explaining it.`);
    if (core.balances.source === "unknown") throw new AppError(422, "BRS_BALANCE_UNKNOWN", "This statement has no balances — type the closing balance printed on the bank's statement.");
    const fp2 = (await brsFingerprints(db, fpArgs)).get(body.month)!;
    if (fp2 !== fp1) throw stale;

    const accepted = [
      ...(core.openItems.count ? ["open_items"] : []), ...(core.coverage.gaps.length ? ["coverage_gap"] : []), ...(core.balances.breaks.length ? ["statement_break"] : []),
    ];
    const max = await db.salesBrsSignoff.aggregate({ where: { bankAccountId: account.id, month: body.month }, _max: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    if (active) await db.salesBrsSignoff.update({ where: { id: active.id }, data: { activeKey: null, supersededAt: new Date(), supersededById: actorId, supersedeKind: "re_reconciled" } });
    const big = (n: number | null) => BigInt(n ?? 0);
    const row = await db.salesBrsSignoff.create({
      data: {
        companyKey: company, bankAccountId: account.id, month: body.month, version, activeKey: `${account.id}:${body.month}`, fingerprint: fp1,
        balanceSource: core.balances.source, openingPaise: big(core.balances.openingPaise), creditsPaise: big(core.balances.creditsPaise), debitsPaise: big(core.balances.debitsPaise),
        closingPaise: big(core.balances.closingPaise), booksPaise: big(core.books.receiptsPaise), openItemsPaise: big(core.openItems.paise), openItemCount: core.openItems.count,
        snapshot: { ...core, defaultAccount: def } as unknown as Prisma.InputJsonValue, accepted, note: body.note ?? null, reconciledById: actorId,
      },
    });
    await logSalesEvent(db, {
      entityType: "brs_month", entityId: `${account.id}:${body.month}`, actorId, action: "reconciled", toStatus: "reconciled",
      note: `v${version} · closing ${reconInr(core.balances.closingPaise ?? 0)} · books ${reconInr(core.books.receiptsPaise)} · ${core.openItems.count} open item${core.openItems.count === 1 ? "" : "s"} ${reconInr(core.openItems.paise)} · fp ${fp1.slice(0, 8)}`,
    });
    return { status: 201, result: { unchanged: false, version: row.version, id: row.id } };
  }, { maxWait: 10_000, timeout: 30_000 });
}

export async function reopenMonth(body: BrsReopenInput, companyQ: CompanyKey | undefined, fallback: CompanyKey, actorId: string) {
  return prisma.$transaction(async (db) => {
    const { account } = await resolveAccount(db, companyQ, body.accountId, fallback);
    if (!account) throw new AppError(404, "NOT_FOUND", "Bank account not found");
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(account.id, body.month)}))`;
    const active = await db.salesBrsSignoff.findFirst({ where: { bankAccountId: account.id, month: body.month, activeKey: { not: null } } });
    if (!active) throw new AppError(409, "BRS_NOT_RECONCILED", `${monthBounds(body.month).label} is not reconciled.`);
    await db.salesBrsSignoff.update({ where: { id: active.id }, data: { activeKey: null, supersededAt: new Date(), supersededById: actorId, supersedeKind: "reopened", supersedeReason: body.reason } });
    await logSalesEvent(db, { entityType: "brs_month", entityId: `${account.id}:${body.month}`, actorId, action: "reopened", fromStatus: "reconciled", toStatus: "open", note: `v${active.version} · ${body.reason}` });
    return { reopened: true, version: active.version };
  }, { maxWait: 10_000, timeout: 30_000 });
}

// ─── PDF / CSV (routes 25, 26) ───────────────────────────────────────────────────────────────

/** The figures a download prints: a version's snapshot (frozen), the current version when the month is reconciled, else live. */
async function downloadSource(companyQ: CompanyKey | undefined, fallback: CompanyKey, accountId: string | undefined, monthQ: string | undefined, versionQ: string | undefined, today: string) {
  const month = checkMonth(monthQ, today);
  const version = versionQ ? Number(versionQ) : null;
  if (versionQ && (!Number.isInteger(version) || version! < 1)) throw new AppError(400, "VALIDATION_ERROR", "version must be a whole number");
  return prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const { account, company } = await resolveAccount(db, companyQ, accountId, fallback);
    if (!account) throw new AppError(404, "NO_BANK_ACCOUNT", "No bank account is set up for this company.");
    const who = async (id: string) => (await names(db, [id])).get(id) ?? "staff";
    if (version) {
      const s = await db.salesBrsSignoff.findUnique({ where: { bankAccountId_month_version: { bankAccountId: account.id, month, version } } });
      if (!s) throw new AppError(404, "NOT_FOUND", `${monthBounds(month).label} has no version ${version}.`);
      const superseded = s.supersededAt ? { kind: s.supersedeKind ?? "reopened", at: s.supersededAt.toISOString(), byName: s.supersededById ? await who(s.supersededById) : "staff", reason: s.supersedeReason } : null;
      return { company, core: s.snapshot as unknown as BrsCore, signoff: s, byName: await who(s.reconciledById), frozen: true, superseded };
    }
    const o = { company, account, month, today, seeDebits: true };
    const b = await buildView(db, o);
    if (b.active && b.active.fingerprint === b.fp) return { company, core: b.active.snapshot as unknown as BrsCore, signoff: b.active, byName: await who(b.active.reconciledById), frozen: true, superseded: null };
    return { company, core: b.core, signoff: null as SignoffRow | null, byName: null as string | null, frozen: false, superseded: null };
  }, RO);
}

/** Debit narrations only for sales:approve (bank's rule) — applied at render, the snapshot keeps them. */
function redact(core: BrsCore, seeDebits: boolean): BrsCore {
  if (seeDebits) return core;
  return { ...core, debits: { ...core.debits, lines: core.debits.lines.map((l) => ({ ...l, narration: "", redacted: true })) } };
}
const fileStem = (company: string, core: BrsCore, version: number | null) => `brs-${company}-${core.account.last4}-${core.month.key}${version ? `-v${version}` : ""}`;

export async function brsPdf(companyQ: CompanyKey | undefined, fallback: CompanyKey, accountId: string | undefined, monthQ: string | undefined, versionQ: string | undefined, today: string, opts: { seeDebits: boolean }) {
  const src = await downloadSource(companyQ, fallback, accountId, monthQ, versionQ, today);
  const seller = await getSellerOrDefaults(src.company);
  const pdf = await renderBrsPdf(redact(src.core, opts.seeDebits), {
    frozen: src.frozen, redactDebits: !opts.seeDebits,
    seller: { legalName: seller.legalName || SALES_COMPANIES[src.company].name, gstins: [seller.gstin, ...((seller.branches ?? []).map((b) => b.gstin))].filter(Boolean) as string[], address: [seller.addressLine1, seller.addressLine2, seller.city, seller.pincode].filter(Boolean).join(", ") },
    signoff: src.signoff ? { version: src.signoff.version, byName: src.byName ?? "staff", at: src.signoff.reconciledAt.toISOString(), note: src.signoff.note, accepted: src.signoff.accepted as string[], fingerprint: src.signoff.fingerprint, superseded: src.superseded } : null,
  });
  return { pdf, filename: `${fileStem(src.company, src.core, src.signoff?.version ?? null)}.pdf` };
}

export async function brsCsv(companyQ: CompanyKey | undefined, fallback: CompanyKey, accountId: string | undefined, monthQ: string | undefined, versionQ: string | undefined, today: string, opts: { seeDebits: boolean; byName: string }) {
  const src = await downloadSource(companyQ, fallback, accountId, monthQ, versionQ, today);
  const seller = await getSellerOrDefaults(src.company);
  const body = buildBrsCsv(redact(src.core, opts.seeDebits), {
    legalName: seller.legalName || SALES_COMPANIES[src.company].name, by: opts.byName, now: new Date(), version: src.signoff?.version ?? null, frozen: src.frozen,
    signoff: src.signoff ? { byName: src.byName ?? "staff", at: src.signoff.reconciledAt, note: src.signoff.note, accepted: src.signoff.accepted as string[], superseded: src.superseded } : null,
  });
  return { body, filename: `${fileStem(src.company, src.core, src.signoff?.version ?? null)}.csv` };
}
