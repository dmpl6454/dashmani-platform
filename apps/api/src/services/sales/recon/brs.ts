import { BANK_IGNORE_LABELS, RECON_TOLERANCE_PAISE, dayAdd, dayDiff, reconDay, reconInr } from "@dashmani/shared";

// Bank reconciliation statement, receipts side (spec-reconcile §5.4, PR 6). PURE: no DB, no clock
// (today is a parameter), no randomness — the same inputs in any order give the same view.
//
// Every rupee of statement credits lands in exactly one group, so the formula
//   books − not credited + credited for other months + unmatched + ignored ± rounding (+ over-matched)
//   = credits as per bank
// ties BY CONSTRUCTION; `ties` is returned and asserted (a false is a bug, never data).

const TOL = RECON_TOLERANCE_PAISE;
/** Bank's own rule: these modes go through the bank, so an unlinked receipt is expected on the default receiving account. */
export const BRS_BANK_MODES = new Set(["bank_transfer", "upi", "cheque", "other"]);
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ─── Inputs ──────────────────────────────────────────────────────────────────────────────────

export interface BrsReceipt { id: string; number: string; paidOn: string; clientName: string; mode: string; amountPaise: number }
export interface BrsLineIn {
  id: string; statementId: string; fileName: string; rowNo: number; txnDate: string;
  narration: string; reference: string | null; utr: string | null;
  creditPaise: number; debitPaise: number; balancePaise: number | null;
  possibleDuplicate: boolean; confidence: string | null; suggestion: unknown;
  ignoreReason: string | null; ignoreNote: string | null; ignoredAt: string | null; ignoredByName: string | null;
  /** RECORDED receipts on the line (voided ones never count). */
  receipts: BrsReceipt[];
}
export interface BrsStatementIn {
  id: string; fileName: string; periodFrom: string; periodTo: string; openingPaise: number | null; closingPaise: number | null;
  /** txn_date of the statement's first and last row by row_no — the file's direction. */
  firstRowDay: string | null; lastRowDay: string | null;
}
/** A recorded receipt of the company dated in the month, with where it is linked. */
export interface BrsBookReceipt extends BrsReceipt { bankLineId: string | null; lineAccountId: string | null; lineDay: string | null; lineIsDuplicate?: boolean }
export interface BrsOpenCredit { lineId: string; accountId: string; accountName: string; txnDate: string; rowNo: number; fileName: string; remainingPaise: number }
export interface BrsAccountIn { id: string; label: string; bank: string; last4: string; ifsc: string | null; matchFrom: string | null }

export interface BrsInput {
  company: string;
  account: BrsAccountIn;
  defaultAccountId: string | null;
  /** "2026-10" */
  month: string;
  today: string;
  lines: BrsLineIn[];
  statements: BrsStatementIn[];
  books: BrsBookReceipt[];
  openCredits: BrsOpenCredit[];
  unlinked: BrsReceipt[];
  /** Issued refunds of the company (a debit hint naming a cancelled refund is dropped). */
  refunds: Array<{ id: string; number: string }>;
  /** Last day of the account's statements (any month) — "not on the statement up to 30 Nov". */
  coverageEnd: string | null;
  /** Lines of the last day before the month (computes last month's closing for the warning). */
  previousDayLines?: BrsLineIn[];
  typedClosingPaise?: number | null;
  seeDebits: boolean;
}

// ─── Output ──────────────────────────────────────────────────────────────────────────────────

export type BrsGroup = "not_credited" | "credited_other_month" | "unmatched" | "ignored" | "rounding" | "over_matched" | "duplicate";
export interface BrsReason { code: string; text: string; action: string | null }
export interface BrsItem {
  key: string; group: BrsGroup; open: boolean; reason: BrsReason; day: string; amountPaise: number;
  line?: { id: string; txnDate: string; rowNo: number; statementId: string; fileName: string; narration: string; reference: string | null; utr: string | null; creditPaise: number; matchedPaise: number };
  receipt?: { id: string; number: string; paidOn: string; clientName: string; mode: string; amountPaise: number; creditedOn: string | null };
  link?: { lineId: string; paymentId: string; text: string };
}
export type BrsBreak = { kind: "day" | "equation" | "statement_open" | "statement_close"; day?: string; fileName?: string; expectedPaise: number | null; foundPaise: number | null; text: string };
export type FormulaKey = "books" | "not_credited" | "credited_other_month" | "unmatched" | "ignored" | "rounding" | "over_matched" | "credits";
export interface BrsCore {
  company: string;
  account: BrsAccountIn;
  month: { key: string; label: string; from: string; to: string; over: boolean };
  coverage: { complete: boolean; gaps: Array<{ from: string; to: string }>; statements: Array<{ id: string; fileName: string; periodFrom: string; periodTo: string }> };
  balances: {
    source: "statement" | "typed" | "unknown"; openingPaise: number | null; creditsPaise: number; creditCount: number; debitsPaise: number; debitCount: number;
    closingPaise: number | null; breaks: BrsBreak[]; warnings: string[]; agreesWith: string | null;
  };
  books: { receiptsPaise: number; receiptCount: number; excluded: { cashPaise: number; cashCount: number; razorpayPaise: number; razorpayCount: number; otherAccountsPaise: number; otherAccountsCount: number } };
  formula: Array<{ key: FormulaKey; label: string; paise: number; count: number }>;
  ties: boolean;
  items: BrsItem[];
  openItems: { count: number; paise: number };
  debits: { totalPaise: number; lines: Array<{ id: string; day: string; amountPaise: number; refund: { id: string; number: string } | null; reversalOf: string | null; narration: string; redacted: boolean }> };
  blockers: Array<{ code: string; sentence: string }>;
  needsAck: Array<"open_items" | "coverage_gap" | "statement_break" | "typed_closing">;
  todo: Array<{ code: string; sentence: string; count: number; paise: number | null; href: string | null }>;
}

// ─── Small helpers ───────────────────────────────────────────────────────────────────────────

export function monthBounds(month: string): { from: string; to: string; next: string; label: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const from = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to: dayAdd(next, -1), next, label: `${MONTHS_LONG[m - 1]} ${y}` };
}
export const monthOf = (day: string) => day.slice(0, 7);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const shortDay = (day: string) => reconDay(day).replace(/ \d{4}$/, "");
/** "1–31 Oct" / "30 Sep–2 Oct" */
function span(from: string, to: string): string {
  if (from === to) return shortDay(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))}–${shortDay(to)}`;
  return `${shortDay(from)}–${shortDay(to)}`;
}
export function accountName(a: { label: string; last4: string }): string { return `${a.label} ••${a.last4}`; }

// ─── Day balances (§5.4.3, order-free) ───────────────────────────────────────────────────────

export interface DayBalance { day: string; start: number; end: number; broken: boolean }

/**
 * Start and end balance of each day from its lines, independent of how the lines are ordered:
 * any line i may be first (Sᵢ = bᵢ − cᵢ + dᵢ), any line k last (Eₖ = bₖ); valid pairs satisfy
 * Eₖ − Sᵢ = net. One distinct pair → it; several or none → the first and last line in statement row
 * order (none = a break that day). null when any line lacks a balance.
 */
export function dayBalances(lines: BrsLineIn[], statements: BrsStatementIn[]): DayBalance[] | null {
  if (lines.some((l) => l.balancePaise === null)) return null;
  const st = new Map(statements.map((s) => [s.id, s]));
  const byDay = new Map<string, BrsLineIn[]>();
  for (const l of lines) (byDay.get(l.txnDate) ?? byDay.set(l.txnDate, []).get(l.txnDate)!).push(l);
  const chrono = (l: BrsLineIn) => {
    const s = st.get(l.statementId);
    const desc = s && s.firstRowDay && s.lastRowDay && s.firstRowDay > s.lastRowDay;
    return desc ? -l.rowNo : l.rowNo;
  };
  const out: DayBalance[] = [];
  for (const day of [...byDay.keys()].sort(cmp)) {
    const ls = byDay.get(day)!;
    const net = ls.reduce((s, l) => s + l.creditPaise - l.debitPaise, 0);
    const starts = new Set(ls.map((l) => l.balancePaise! - l.creditPaise + l.debitPaise));
    const ends = new Set(ls.map((l) => l.balancePaise!));
    const valid = [...starts].filter((s) => ends.has(s + net));
    if (valid.length === 1) { out.push({ day, start: valid[0], end: valid[0] + net, broken: false }); continue; }
    const ordered = [...ls].sort((a, b) => {
      const sa = st.get(a.statementId), sb = st.get(b.statementId);
      return cmp(sa?.periodFrom ?? "", sb?.periodFrom ?? "") || cmp(a.statementId, b.statementId) || chrono(a) - chrono(b) || cmp(a.id, b.id);
    });
    const first = ordered[0], last = ordered[ordered.length - 1];
    out.push({ day, start: first.balancePaise! - first.creditPaise + first.debitPaise, end: last.balancePaise!, broken: valid.length === 0 });
  }
  return out;
}

// ─── Coverage (§5.4.3) ───────────────────────────────────────────────────────────────────────

export function coverageOf(statements: BrsStatementIn[], from: string, to: string): { touches: boolean; complete: boolean; gaps: Array<{ from: string; to: string }> } {
  const touching = statements.filter((s) => s.periodTo >= from && s.periodFrom <= to);
  const sorted = [...statements].sort((a, b) => cmp(a.periodFrom, b.periodFrom) || cmp(a.periodTo, b.periodTo) || cmp(a.id, b.id));
  const merged: Array<{ from: string; to: string; closing: number | null }> = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    const bridged = prev && prev.closing !== null && s.openingPaise !== null && prev.closing === s.openingPaise;
    if (prev && (s.periodFrom <= dayAdd(prev.to, 1) || bridged)) {
      if (s.periodTo >= prev.to) { prev.to = s.periodTo; prev.closing = s.closingPaise; }
    } else merged.push({ from: s.periodFrom, to: s.periodTo, closing: s.closingPaise });
  }
  const gaps: Array<{ from: string; to: string }> = [];
  let cursor = from;
  for (const iv of merged) {
    if (iv.to < cursor) continue;
    if (iv.from > to) break;
    if (iv.from > cursor) gaps.push({ from: cursor, to: dayAdd(iv.from, -1) < to ? dayAdd(iv.from, -1) : to });
    cursor = dayAdd(iv.to, 1);
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return { touches: touching.length > 0, complete: touching.length > 0 && gaps.length === 0, gaps: touching.length ? gaps : [{ from, to }] };
}

// ─── Reasons ─────────────────────────────────────────────────────────────────────────────────

const reason = (code: string, text: string, action: string | null = null): BrsReason => ({ code, text, action });

function suggestionText(s: unknown): string | null {
  if (!s || typeof s !== "object" || !("candidates" in s)) return null;
  const c = (s as { candidates?: Array<{ kind?: string; allocations?: Array<{ number?: string }> }> }).candidates?.[0];
  if (!c) return null;
  const nums = (c.allocations ?? []).map((a) => a.number).filter(Boolean) as string[];
  return nums.length ? `Bank suggests ${nums.join(" + ")} — confirm it on Bank` : "Bank suggests an advance — confirm it on Bank";
}
function debitHint(s: unknown): { refund?: { id: string; number: string }; reversalOf?: { txnDate: string } } | null {
  if (!s || typeof s !== "object" || !("debitHint" in s)) return null;
  return (s as { debitHint: { refund?: { id: string; number: string }; reversalOf?: { txnDate: string } } | null }).debitHint ?? null;
}

// ─── The statement ───────────────────────────────────────────────────────────────────────────

export function buildBrs(input: BrsInput): BrsCore {
  const mb = monthBounds(input.month);
  const { from, to } = mb;
  const over = to < input.today;
  const acc = input.account;
  const accName = accountName(acc);
  const isDefault = input.defaultAccountId === acc.id;

  const lines = [...input.lines].sort((a, b) => cmp(a.txnDate, b.txnDate) || cmp(a.statementId, b.statementId) || a.rowNo - b.rowNo || cmp(a.id, b.id));
  const dupLines = lines.filter((l) => l.ignoreReason === "duplicate");
  const real = lines.filter((l) => l.ignoreReason !== "duplicate");
  const realIds = new Set(real.map((l) => l.id));
  const credits = real.reduce((s, l) => s + l.creditPaise, 0);
  const debits = real.reduce((s, l) => s + l.debitPaise, 0);
  const creditCount = real.filter((l) => l.creditPaise > 0).length;
  const debitCount = real.filter((l) => l.debitPaise > 0).length;

  // ── Balances ──
  const stmts = [...input.statements].sort((a, b) => cmp(a.periodFrom, b.periodFrom) || cmp(a.id, b.id));
  const days = real.length ? dayBalances(real, stmts) : null;
  let source: BrsCore["balances"]["source"] = "unknown";
  let opening: number | null = null;
  let closing: number | null = null;
  const breaks: BrsBreak[] = [];
  const warnings: string[] = [];
  let agreesWith: string | null = null;
  if (days && days.length) {
    source = "statement";
    opening = days[0].start;
    closing = days[days.length - 1].end;
    for (const d of days) if (d.broken) breaks.push({ kind: "day", day: d.day, expectedPaise: null, foundPaise: null, text: `The balances on ${reconDay(d.day)} do not follow from that day's transactions` });
    for (let i = 0; i + 1 < days.length; i++) {
      if (days[i].end !== days[i + 1].start) {
        breaks.push({ kind: "day", day: days[i + 1].day, expectedPaise: days[i].end, foundPaise: days[i + 1].start,
          text: `The balances break between ${shortDay(days[i].day)} and ${shortDay(days[i + 1].day)} (${reconInr(Math.abs(days[i + 1].start - days[i].end))})` });
      }
    }
    const dayOf = new Map(days.map((d) => [d.day, d]));
    for (const s of stmts) {
      const own = real.filter((l) => l.statementId === s.id);
      if (!own.length) continue;
      const firstDay = own.reduce((m, l) => (l.txnDate < m ? l.txnDate : m), own[0].txnDate);
      const lastDay = own.reduce((m, l) => (l.txnDate > m ? l.txnDate : m), own[0].txnDate);
      if (s.periodFrom >= from && s.openingPaise !== null && dayOf.get(firstDay) && dayOf.get(firstDay)!.start !== s.openingPaise) {
        breaks.push({ kind: "statement_open", day: firstDay, fileName: s.fileName, expectedPaise: s.openingPaise, foundPaise: dayOf.get(firstDay)!.start,
          text: `${s.fileName} opens at ${reconInr(s.openingPaise)}, but its first day starts at ${reconInr(dayOf.get(firstDay)!.start)}` });
      }
      if (s.periodTo < mb.next && s.periodTo >= from && s.closingPaise !== null && dayOf.get(lastDay) && dayOf.get(lastDay)!.end !== s.closingPaise) {
        breaks.push({ kind: "statement_close", day: lastDay, fileName: s.fileName, expectedPaise: s.closingPaise, foundPaise: dayOf.get(lastDay)!.end,
          text: `${s.fileName} closes at ${reconInr(s.closingPaise)}, but its last day ends at ${reconInr(dayOf.get(lastDay)!.end)}` });
      }
    }
  } else {
    const st0 = stmts.find((s) => s.periodFrom === from && s.openingPaise !== null);
    const st1 = stmts.find((s) => s.periodTo === to && s.closingPaise !== null);
    if (st0 || st1) {
      source = "statement";
      opening = st0 ? st0.openingPaise : st1!.closingPaise! - credits + debits;
      closing = st1 ? st1.closingPaise : st0!.openingPaise! + credits - debits;
    }
  }
  if (source === "unknown" && input.typedClosingPaise != null) {
    source = "typed";
    closing = input.typedClosingPaise;
    opening = closing - credits + debits;
  }
  if (source === "statement" && opening !== null && closing !== null && opening + credits - debits !== closing) {
    breaks.push({ kind: "equation", expectedPaise: opening + credits - debits, foundPaise: closing,
      text: `Opening ${reconInr(opening)} + credits − withdrawals = ${reconInr(opening + credits - debits)}, but the closing balance is ${reconInr(closing)}` });
  }
  if (source === "statement" && closing !== null && !breaks.length) {
    const closer = [...stmts].reverse().find((s) => s.periodTo >= from && s.periodFrom <= to);
    if (closer) agreesWith = closer.fileName;
  }
  if (opening !== null && input.previousDayLines?.length) {
    const prev = dayBalances(input.previousDayLines.filter((l) => l.ignoreReason !== "duplicate"), stmts);
    if (prev && prev.length && prev[prev.length - 1].end !== opening) {
      warnings.push(`Last month's closing balance (${reconInr(prev[prev.length - 1].end)}) is not this month's opening (${reconInr(opening)})`);
    }
  }
  const breaksListed = breaks.slice(0, 10);

  // ── Coverage ──
  const cov = coverageOf(stmts, from, to);
  const coverage = {
    complete: cov.complete,
    gaps: cov.gaps,
    statements: stmts.filter((s) => s.periodTo >= from && s.periodFrom <= to).map((s) => ({ id: s.id, fileName: s.fileName, periodFrom: s.periodFrom, periodTo: s.periodTo })),
  };

  // ── Items ──
  const items: BrsItem[] = [];
  const usedReceipts = new Set<string>();
  const usedCredits = new Set<string>();
  const unlinked = [...input.unlinked].sort((a, b) => cmp(a.paidOn, b.paidOn) || cmp(a.number, b.number) || cmp(a.id, b.id));
  const lineView = (l: BrsLineIn, m: number) => ({ id: l.id, txnDate: l.txnDate, rowNo: l.rowNo, statementId: l.statementId, fileName: l.fileName, narration: l.narration, reference: l.reference, utr: l.utr, creditPaise: l.creditPaise, matchedPaise: m });
  const inMonthOnLine = new Map<string, BrsReceipt>();

  for (const l of real.filter((x) => x.creditPaise > 0)) {
    const m = l.receipts.reduce((s, r) => s + r.amountPaise, 0);
    const rem = l.creditPaise - m;
    for (const r of l.receipts) {
      if (r.paidOn >= from && r.paidOn <= to) { inMonthOnLine.set(r.id, r); continue; }
      items.push({ key: `com:${l.id}:${r.id}`, group: "credited_other_month", open: false, day: l.txnDate, amountPaise: r.amountPaise,
        reason: reason("OTHER_MONTH", `${r.number} is dated ${reconDay(r.paidOn)}`),
        line: lineView(l, m), receipt: { ...r, creditedOn: l.txnDate } });
    }
    if (l.ignoreReason) {
      if (rem !== 0) {
        const label = l.ignoreReason === "before_cutover" ? "Before bank matching started" : BANK_IGNORE_LABELS[l.ignoreReason] ?? l.ignoreReason;
        const who = [l.ignoreNote, l.ignoredByName && l.ignoredAt ? `${l.ignoredByName}, ${reconDay(l.ignoredAt.slice(0, 10))}` : null].filter(Boolean).join(" · ");
        items.push({ key: `line:${l.id}`, group: "ignored", open: false, day: l.txnDate, amountPaise: rem, reason: reason(`IGNORED_${l.ignoreReason.toUpperCase()}`, who ? `${label} — ${who}` : label), line: lineView(l, m) });
      }
      continue;
    }
    if (rem > TOL) {
      let r: BrsReason;
      let link: BrsItem["link"];
      const fit = unlinked.find((u) => !usedReceipts.has(u.id) && Math.abs(u.amountPaise - rem) <= TOL && Math.abs(dayDiff(u.paidOn, l.txnDate)) <= 7);
      const sugg = l.confidence === "high" || l.confidence === "medium" ? suggestionText(l.suggestion) : null;
      if (m > 0) r = reason("PARTLY_RECORDED", `${reconInr(m)} recorded on ${l.receipts.map((x) => x.number).join(", ")}; ${reconInr(rem)} left`, "Record the rest on Bank, or ignore it with a reason");
      else if (l.possibleDuplicate) r = reason("POSSIBLE_DUPLICATE", "This credit may be a second copy of another line", "Check it on Bank — ignore it as a duplicate if it is one");
      else if (fit) {
        usedReceipts.add(fit.id);
        r = reason("RECEIPT_FITS", `already recorded as ${fit.number}?`, "Link");
        link = { lineId: l.id, paymentId: fit.id, text: `Link ${fit.number}` };
      } else if (sugg) r = reason("SUGGESTED", sugg, "Open on Bank");
      else r = reason("NO_MATCH", "no invoice or receipt fits", "Record it as an advance on Bank, or ignore it with a reason");
      items.push({ key: `line:${l.id}`, group: "unmatched", open: true, day: l.txnDate, amountPaise: rem, reason: r, line: lineView(l, m),
        ...(fit && r.code === "RECEIPT_FITS" ? { receipt: { ...fit, creditedOn: null }, link } : {}) });
    } else if (rem !== 0 && Math.abs(rem) <= TOL) {
      items.push({ key: `line:${l.id}`, group: "rounding", open: false, day: l.txnDate, amountPaise: rem, reason: reason("ROUNDING", `${reconInr(rem)} rounding between the credit and its receipts`), line: lineView(l, m) });
    } else if (rem < -TOL) {
      items.push({ key: `line:${l.id}`, group: "over_matched", open: true, day: l.txnDate, amountPaise: rem,
        reason: reason("OVER_MATCHED", `Receipts of ${reconInr(m)} on a credit of ${reconInr(l.creditPaise)}`, "Unlink the extra receipt on Bank"), line: lineView(l, m) });
    }
  }

  // ── Books (§5.4.2) ──
  const books = new Map<string, BrsBookReceipt>();
  const excluded = { cashPaise: 0, cashCount: 0, razorpayPaise: 0, razorpayCount: 0, otherAccountsPaise: 0, otherAccountsCount: 0 };
  for (const b of input.books) {
    if (b.paidOn < from || b.paidOn > to) continue;
    if (inMonthOnLine.has(b.id)) { books.set(b.id, b); continue; }
    if (b.bankLineId) {
      if (b.lineAccountId === acc.id) books.set(b.id, b);
      else { excluded.otherAccountsPaise += b.amountPaise; excluded.otherAccountsCount++; }
    } else if (BRS_BANK_MODES.has(b.mode)) {
      if (isDefault) books.set(b.id, b);
      else { excluded.otherAccountsPaise += b.amountPaise; excluded.otherAccountsCount++; }
    } else if (b.mode === "razorpay") { excluded.razorpayPaise += b.amountPaise; excluded.razorpayCount++; }
    else { excluded.cashPaise += b.amountPaise; excluded.cashCount++; }
  }
  // Receipts on this month's lines but missing from the books feed (another company's — never under bank's guards) still count.
  for (const [id, r] of inMonthOnLine) if (!books.has(id)) books.set(id, { ...r, bankLineId: null, lineAccountId: acc.id, lineDay: null });
  const booksList = [...books.values()].sort((a, b) => cmp(a.paidOn, b.paidOn) || cmp(a.number, b.number) || cmp(a.id, b.id));
  const opens = [...input.openCredits].sort((a, b) => cmp(a.txnDate, b.txnDate) || cmp(a.accountId, b.accountId) || a.rowNo - b.rowNo || cmp(a.lineId, b.lineId));
  for (const b of booksList) {
    if (inMonthOnLine.has(b.id)) continue;
    const rv = { id: b.id, number: b.number, paidOn: b.paidOn, clientName: b.clientName, mode: b.mode, amountPaise: b.amountPaise };
    if (b.bankLineId && b.lineAccountId === acc.id && b.lineDay && !(b.lineDay >= from && b.lineDay <= to)) {
      const later = b.lineDay > to;
      items.push({ key: `nc:${b.id}`, group: "not_credited", open: false, day: b.paidOn, amountPaise: b.amountPaise,
        reason: reason(later ? "CREDITED_LATER" : "CREDITED_EARLIER", `credited ${reconDay(b.lineDay)}`), receipt: { ...rv, creditedOn: b.lineDay } });
      continue;
    }
    if (b.bankLineId) {
      // Linked to a line of this month that is stored twice (or otherwise not counted).
      items.push({ key: `nc:${b.id}`, group: "not_credited", open: true, day: b.paidOn, amountPaise: b.amountPaise,
        reason: reason("ON_UNCOUNTED_LINE", "linked to a line that is not counted (stored twice)", "Unlink it on Bank and link the real line"), receipt: { ...rv, creditedOn: b.lineDay } });
      continue;
    }
    let r: BrsReason;
    let link: BrsItem["link"];
    const fit = opens.find((o) => !usedCredits.has(o.lineId) && Math.abs(o.remainingPaise - b.amountPaise) <= TOL && Math.abs(dayDiff(b.paidOn, o.txnDate)) <= 7);
    if (acc.matchFrom && b.paidOn < acc.matchFrom) r = reason("BEFORE_CUTOVER", `dated before bank matching started (${reconDay(acc.matchFrom)})`);
    else if (fit) {
      usedCredits.add(fit.lineId);
      r = reason("CREDIT_FITS", `looks like the credit of ${shortDay(fit.txnDate)} on ${fit.accountName}, row ${fit.rowNo} of ${fit.fileName}`, "Link");
      link = { lineId: fit.lineId, paymentId: b.id, text: `Link to the credit of ${shortDay(fit.txnDate)}` };
    } else if (!input.coverageEnd || input.coverageEnd < dayAdd(b.paidOn, 3)) r = reason("NOT_UPLOADED_YET", input.coverageEnd ? `statements are uploaded up to ${reconDay(input.coverageEnd)}` : "no statement is uploaded yet", "Upload the next statement on Bank");
    else if (b.mode === "cheque" && dayDiff(b.paidOn, input.coverageEnd) < 7) r = reason("CHEQUE_CLEARING", "a cheque still clearing", null);
    else r = reason("NOT_ON_STATEMENT", `not on the statement up to ${reconDay(input.coverageEnd)} — check the date, amount or account; void the receipt if no money came`, "Open receipt");
    items.push({ key: `nc:${b.id}`, group: "not_credited", open: true, day: b.paidOn, amountPaise: b.amountPaise, reason: r, receipt: { ...rv, creditedOn: null }, ...(link ? { link } : {}) });
  }

  for (const l of dupLines) {
    items.push({ key: `line:${l.id}`, group: "duplicate", open: false, day: l.txnDate, amountPaise: l.creditPaise || -l.debitPaise,
      reason: reason("DUPLICATE", "Stored twice — not counted"), line: lineView(l, l.receipts.reduce((s, r) => s + r.amountPaise, 0)) });
  }

  const ORDER: BrsGroup[] = ["not_credited", "credited_other_month", "unmatched", "ignored", "rounding", "over_matched", "duplicate"];
  items.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || cmp(a.day, b.day) || cmp(a.key, b.key));

  // ── Formula (§5.4.5) ──
  const sum = (g: BrsGroup) => items.filter((i) => i.group === g).reduce((s, i) => s + i.amountPaise, 0);
  const count = (g: BrsGroup) => items.filter((i) => i.group === g).length;
  const booksPaise = booksList.reduce((s, b) => s + b.amountPaise, 0);
  const mLabel = mb.label.split(" ")[0];
  const formula: BrsCore["formula"] = [
    { key: "books", label: `Receipts recorded in the portal in ${mb.label} (as per books)`, paise: booksPaise, count: booksList.length },
    { key: "not_credited", label: `Recorded in ${mLabel}, not credited by the bank in ${mLabel}`, paise: sum("not_credited"), count: count("not_credited") },
    { key: "credited_other_month", label: `Credited in ${mLabel} for receipts dated in other months`, paise: sum("credited_other_month"), count: count("credited_other_month") },
    { key: "unmatched", label: "Credits not yet matched to a receipt", paise: sum("unmatched"), count: count("unmatched") },
    { key: "ignored", label: "Credits ignored on Bank, by reason (not sales money, before cut-over)", paise: sum("ignored"), count: count("ignored") },
    { key: "rounding", label: "Rounding on matched credits (±₹1)", paise: sum("rounding"), count: count("rounding") },
    ...(count("over_matched") ? [{ key: "over_matched" as const, label: "Credits carrying more receipts than their amount", paise: sum("over_matched"), count: count("over_matched") }] : []),
    { key: "credits", label: `Credits as per bank statement, ${mb.label}`, paise: credits, count: creditCount },
  ];
  const ties = booksPaise - sum("not_credited") + sum("credited_other_month") + sum("unmatched") + sum("ignored") + sum("rounding") + sum("over_matched") === credits;
  const openList = items.filter((i) => i.open && i.group !== "over_matched");
  const openItems = { count: openList.length, paise: openList.reduce((s, i) => s + i.amountPaise, 0) };

  // ── Debits ──
  const refundIds = new Set(input.refunds.map((r) => r.id));
  const debitLines = real.filter((l) => l.debitPaise > 0).map((l) => {
    const h = debitHint(l.suggestion);
    const refund = h?.refund && refundIds.has(h.refund.id) ? { id: h.refund.id, number: h.refund.number } : null;
    return { id: l.id, day: l.txnDate, amountPaise: l.debitPaise, refund, reversalOf: h?.reversalOf?.txnDate ? `reversal of the credit of ${shortDay(h.reversalOf.txnDate)}` : null,
      narration: input.seeDebits ? l.narration : "", redacted: !input.seeDebits };
  });

  // ── Blockers, acknowledgements, to-do ──
  const blockers: BrsCore["blockers"] = [];
  if (!over) blockers.push({ code: "MONTH_NOT_OVER", sentence: `${mb.label} isn't over yet — it can be reconciled from ${reconDay(mb.next)}.` });
  if (!cov.touches) blockers.push({ code: "BRS_NO_STATEMENT", sentence: `No statement of ${accName} covers ${mb.label} — upload it on Bank.` });
  if (!ties) blockers.push({ code: "BRS_DID_NOT_TIE", sentence: "The figures do not add up — this is a bug; reconciling is refused until it is fixed." });
  if (count("over_matched")) blockers.push({ code: "BRS_OVER_MATCHED", sentence: "A credit carries more receipts than its amount — unlink the extra receipt on Bank first." });
  const needsAck: BrsCore["needsAck"] = [];
  if (openItems.count) needsAck.push("open_items");
  if (cov.touches && cov.gaps.length) needsAck.push("coverage_gap");
  if (breaks.length) needsAck.push("statement_break");
  if (source === "unknown") needsAck.push("typed_closing");

  const todo: BrsCore["todo"] = [];
  const href = (p: string) => p;
  for (const g of cov.touches ? cov.gaps : []) todo.push({ code: "UPLOAD_GAP", sentence: `Upload the statement for ${span(g.from, g.to)}`, count: 1, paise: null, href: href("/bank/upload") });
  if (!cov.touches) todo.push({ code: "UPLOAD", sentence: `Upload the statement of ${accName} for ${mb.label}`, count: 1, paise: null, href: href("/bank/upload") });
  for (const b of breaksListed.slice(0, 3)) {
    const st = b.fileName ? stmts.find((s) => s.fileName === b.fileName) : real.find((l) => l.txnDate === b.day) ? stmts.find((s) => s.id === real.find((l) => l.txnDate === b.day)!.statementId) : undefined;
    todo.push({ code: "BREAK", sentence: b.text, count: 1, paise: b.expectedPaise !== null && b.foundPaise !== null ? Math.abs(b.expectedPaise - b.foundPaise) : null, href: st ? `/bank/statement?id=${st.id}` : null });
  }
  if (source === "unknown") todo.push({ code: "TYPE_CLOSING", sentence: "This statement has no balances — type the closing balance printed on the bank's statement when you reconcile", count: 1, paise: null, href: null });
  const unm = items.filter((i) => i.group === "unmatched");
  if (unm.length) todo.push({ code: "RECORD_CREDITS", sentence: `Record ${unm.length} credit${unm.length === 1 ? "" : "s"} (${reconInr(sum("unmatched"))}), or ignore ${unm.length === 1 ? "it" : "them"} with a reason`, count: unm.length, paise: sum("unmatched"), href: `/bank?accountId=${acc.id}` });
  const ncOpen = items.filter((i) => i.group === "not_credited" && i.open);
  if (ncOpen.length) todo.push({ code: "NOT_ON_STATEMENT", sentence: `${ncOpen.length} receipt${ncOpen.length === 1 ? "" : "s"} (${reconInr(ncOpen.reduce((s, i) => s + i.amountPaise, 0))}) ${ncOpen.length === 1 ? "is" : "are"} not on any statement`, count: ncOpen.length, paise: ncOpen.reduce((s, i) => s + i.amountPaise, 0), href: null });
  if (count("over_matched")) todo.push({ code: "OVER_MATCHED", sentence: "A credit carries more receipts than its amount — unlink the extra one on Bank", count: count("over_matched"), paise: null, href: `/bank?accountId=${acc.id}` });
  if (!todo.length && over && ties) todo.push({ code: "RECONCILE", sentence: `Everything is explained — mark ${mLabel} reconciled`, count: 0, paise: null, href: null });

  return {
    company: input.company,
    account: acc,
    month: { key: input.month, label: mb.label, from, to, over },
    coverage,
    balances: { source, openingPaise: opening, creditsPaise: credits, creditCount, debitsPaise: debits, debitCount, closingPaise: closing, breaks: breaksListed, warnings, agreesWith },
    books: { receiptsPaise: booksPaise, receiptCount: booksList.length, excluded },
    formula, ties, items, openItems,
    debits: { totalPaise: debits, lines: debitLines },
    blockers, needsAck, todo,
  };
}

// ─── State and changes (§5.4.7) ──────────────────────────────────────────────────────────────

export type BrsState = "running" | "open" | "reconciled" | "changed";
export function brsState(o: { monthTo: string; today: string; activeFingerprint: string | null; liveFingerprint: string }): BrsState {
  if (o.activeFingerprint) return o.activeFingerprint === o.liveFingerprint ? "reconciled" : "changed";
  if (o.monthTo >= o.today) return "running";
  return "open";
}

/** Items added/removed by key and the figures that moved, frozen vs live. */
export function brsChanges(frozen: Pick<BrsCore, "items" | "formula" | "balances">, live: Pick<BrsCore, "items" | "formula" | "balances">) {
  const sig = (i: BrsItem) => `${i.key}|${i.group}|${i.amountPaise}`;
  const fz = new Map(frozen.items.map((i) => [sig(i), i]));
  const lv = new Map(live.items.map((i) => [sig(i), i]));
  const added = live.items.filter((i) => !fz.has(sig(i)));
  const removed = frozen.items.filter((i) => !lv.has(sig(i)));
  const figures: Array<{ key: string; frozenPaise: number | null; livePaise: number | null }> = [];
  for (const k of ["openingPaise", "creditsPaise", "debitsPaise", "closingPaise"] as const) {
    if (frozen.balances[k] !== live.balances[k]) figures.push({ key: k.replace(/Paise$/, ""), frozenPaise: frozen.balances[k], livePaise: live.balances[k] });
  }
  const fm = new Map(frozen.formula.map((f) => [f.key, f.paise]));
  for (const f of live.formula) if (f.key !== "credits" && (fm.get(f.key) ?? 0) !== f.paise) figures.push({ key: f.key, frozenPaise: fm.get(f.key) ?? 0, livePaise: f.paise });
  return { added, removed, figures };
}
