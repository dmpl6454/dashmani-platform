/**
 * The bank reconciliation statement, pure (spec-reconcile §10.4, B-1…B-10). No database: buildBrs
 * takes plain inputs. The §5.4.8 worked example is the fixture; the property test builds 300
 * random months from a seeded PRNG.
 */
import { describe, it, expect } from "vitest";
import zlib from "zlib";
import { bankBalanceFromSide } from "@dashmani/shared";
import { renderBrsPdf } from "../src/services/sales/recon/recon-pdf";
import {
  brsChanges, brsState, buildBrs, coverageOf, dayBalances, monthBounds,
  type BrsBookReceipt, type BrsInput, type BrsLineIn, type BrsReceipt, type BrsStatementIn,
} from "../src/services/sales/recon/brs";

const R = (rupees: number) => Math.round(rupees * 100);
const ACC = { id: "acc-idfc", label: "IDFC First", bank: "idfc", last4: "8788", ifsc: "IDFB0040178", matchFrom: "2023-04-01" };

let seq = 0;
function line(day: string, o: Partial<BrsLineIn> & { cr?: number; dr?: number; bal?: number | null; st?: string } = {}): BrsLineIn {
  seq++;
  return {
    id: o.id ?? `l${String(seq).padStart(4, "0")}`, statementId: o.st ?? "st-oct", fileName: o.fileName ?? (o.st === "st-nov" ? "nov.csv" : o.st === "st-sep" ? "sep.csv" : "oct.csv"), rowNo: o.rowNo ?? seq, txnDate: day,
    narration: o.narration ?? `NEFT ${seq}`, reference: null, utr: null, creditPaise: o.cr ?? 0, debitPaise: o.dr ?? 0, balancePaise: o.bal === undefined ? null : o.bal,
    possibleDuplicate: o.possibleDuplicate ?? false, confidence: o.confidence ?? null, suggestion: o.suggestion ?? null,
    ignoreReason: o.ignoreReason ?? null, ignoreNote: o.ignoreNote ?? null, ignoredAt: o.ignoreReason ? "2026-11-02T10:00:00Z" : null, ignoredByName: o.ignoreReason ? "Riya Shah" : null,
    receipts: o.receipts ?? [],
  };
}
const rcpt = (number: string, paidOn: string, amount: number, mode = "bank_transfer", client = "Filmy Brands"): BrsReceipt => ({ id: `p-${number}`, number, paidOn, clientName: client, mode, amountPaise: amount });
const book = (r: BrsReceipt, link: { lineId: string; account?: string; day: string } | null = null): BrsBookReceipt =>
  ({ ...r, bankLineId: link?.lineId ?? null, lineAccountId: link ? link.account ?? ACC.id : null, lineDay: link?.day ?? null });

/** Running balances in row order from an opening. */
function withBalances(lines: BrsLineIn[], opening: number): BrsLineIn[] {
  let b = opening;
  return lines.map((l) => { b += l.creditPaise - l.debitPaise; return { ...l, balancePaise: b }; });
}

// ─── §5.4.8 worked example ──────────────────────────────────────────────────────────────────
function october(): BrsInput {
  seq = 0;
  const r38 = rcpt("RCPT/26-27/0038", "2026-09-30", R(50000));
  const r40 = rcpt("RCPT/26-27/0040", "2026-10-14", R(118000));
  const r41 = rcpt("RCPT/26-27/0041", "2026-10-20", R(108000));
  const r45 = rcpt("RCPT/26-27/0045", "2026-10-31", R(10000));
  const r43 = rcpt("RCPT/26-27/0043", "2026-10-29", R(25000), "cheque", "Kanara Foods");
  const r44 = rcpt("RCPT/26-27/0044", "2026-10-30", R(60000), "upi", "Hunch Media");
  const raw = [
    line("2026-10-02", { id: "L02", cr: R(50000), receipts: [r38] }),
    line("2026-10-05", { id: "L05", dr: R(40000), ignoreReason: "debit" }),
    line("2026-10-14", { id: "L14", cr: R(118000), receipts: [r40] }),
    line("2026-10-15", { id: "L15", dr: R(50000), ignoreReason: "debit", suggestion: { v: 1, debitHint: { refund: { id: "rf3", number: "RF/26-27/0003" } } }, narration: "IMPS REFUND HUNCH" }),
    line("2026-10-20", { id: "L20", cr: R(108000.4), receipts: [r41] }),
    line("2026-10-22", { id: "L22", cr: R(2500), ignoreReason: "interest" }),
    line("2026-10-25", { id: "L25", cr: R(300000), ignoreReason: "own_transfer" }),
    line("2026-10-26", { id: "L26", dr: R(60000), ignoreReason: "debit" }),
    line("2026-10-28", { id: "L28", cr: R(40000) }),
    line("2026-10-29", { id: "L29", dr: R(30000), ignoreReason: "debit" }),
    line("2026-10-30", { id: "L30", dr: R(35000), ignoreReason: "debit" }),
    line("2026-10-31", { id: "L31a", cr: R(15000), receipts: [r45] }),
    line("2026-10-31", { id: "L31b", dr: R(30000), ignoreReason: "debit", suggestion: { v: 1, debitHint: { reversalOf: { lineId: "L14", txnDate: "2026-10-14", receiptNumbers: [] } } } }),
  ];
  const lines = withBalances(raw, R(402118.4));
  const statements: BrsStatementIn[] = [
    { id: "st-sep", fileName: "sep.csv", periodFrom: "2026-09-01", periodTo: "2026-09-30", openingPaise: R(300000), closingPaise: R(402118.4), firstRowDay: "2026-09-01", lastRowDay: "2026-09-30" },
    { id: "st-oct", fileName: "oct.csv", periodFrom: "2026-10-01", periodTo: "2026-10-31", openingPaise: R(402118.4), closingPaise: R(790618.8), firstRowDay: "2026-10-02", lastRowDay: "2026-10-31" },
    { id: "st-nov", fileName: "nov.csv", periodFrom: "2026-11-01", periodTo: "2026-11-04", openingPaise: R(790618.8), closingPaise: R(850618.8), firstRowDay: "2026-11-02", lastRowDay: "2026-11-02" },
  ];
  const books = [
    book(r40, { lineId: "L14", day: "2026-10-14" }), book(r41, { lineId: "L20", day: "2026-10-20" }), book(r45, { lineId: "L31a", day: "2026-10-31" }),
    book(r43), book(r44, { lineId: "Lnov2", day: "2026-11-02" }),
    book(rcpt("RCPT/26-27/0046", "2026-10-10", R(20000), "razorpay")), book(rcpt("RCPT/26-27/0047", "2026-10-18", R(25000), "razorpay")),
    book(rcpt("RCPT/26-27/0042", "2026-10-21", R(5000), "cash")),
  ];
  return {
    company: "dspl", account: ACC, defaultAccountId: ACC.id, month: "2026-10", today: "2026-11-05",
    lines, statements, books,
    openCredits: [
      { lineId: "L28", accountId: ACC.id, accountName: "IDFC First ••8788", txnDate: "2026-10-28", rowNo: 9, fileName: "oct.csv", remainingPaise: R(40000) },
      { lineId: "L31a", accountId: ACC.id, accountName: "IDFC First ••8788", txnDate: "2026-10-31", rowNo: 12, fileName: "oct.csv", remainingPaise: R(5000) },
    ],
    unlinked: [r43, rcpt("RCPT/26-27/0042", "2026-10-21", R(5000), "cash")],
    refunds: [{ id: "rf3", number: "RF/26-27/0003" }],
    coverageEnd: "2026-11-04",
    previousDayLines: [line("2026-09-30", { st: "st-sep", cr: R(1000), bal: R(402118.4) })],
    seeDebits: true,
  };
}

describe("BRS — pure (§10.4)", () => {
  it("B-1 the §5.4.8 example: every figure, item, group, reason, open items ₹70,000.00 / 3, ties", () => {
    const v = buildBrs(october());
    expect(v.ties).toBe(true);
    expect(v.balances).toMatchObject({ source: "statement", openingPaise: R(402118.4), creditsPaise: R(633500.4), creditCount: 7, debitsPaise: R(245000), debitCount: 6, closingPaise: R(790618.8), breaks: [], warnings: [], agreesWith: "oct.csv" });
    const f = Object.fromEntries(v.formula.map((x) => [x.key, x.paise]));
    expect(f).toEqual({ books: R(321000), not_credited: R(85000), credited_other_month: R(50000), unmatched: R(45000), ignored: R(302500), rounding: 40, credits: R(633500.4) });
    expect(v.openItems).toEqual({ count: 3, paise: R(70000) });
    const by = (key: string) => v.items.find((i) => i.key === key)!;
    expect(by("com:L02:p-RCPT/26-27/0038")).toMatchObject({ group: "credited_other_month", amountPaise: R(50000), reason: { code: "OTHER_MONTH", text: "RCPT/26-27/0038 is dated 30 Sep 2026" } });
    expect(by("line:L20")).toMatchObject({ group: "rounding", amountPaise: 40 });
    expect(by("line:L22")).toMatchObject({ group: "ignored", amountPaise: R(2500), reason: { text: expect.stringContaining("Bank interest / FD") } });
    expect(by("line:L25")).toMatchObject({ group: "ignored", amountPaise: R(300000), reason: { text: expect.stringContaining("Transfer between our own accounts") } });
    expect(by("line:L28")).toMatchObject({ group: "unmatched", open: true, amountPaise: R(40000), reason: { code: "NO_MATCH" } });
    expect(by("line:L31a")).toMatchObject({ group: "unmatched", open: true, amountPaise: R(5000), reason: { code: "PARTLY_RECORDED", text: "₹10,000.00 recorded on RCPT/26-27/0045; ₹5,000.00 left" } });
    expect(by("nc:p-RCPT/26-27/0043")).toMatchObject({ group: "not_credited", open: true, amountPaise: R(25000), reason: { code: "CHEQUE_CLEARING" } });
    expect(by("nc:p-RCPT/26-27/0044")).toMatchObject({ group: "not_credited", open: false, amountPaise: R(60000), reason: { code: "CREDITED_LATER", text: "credited 2 Nov 2026" } });
    expect(v.books).toMatchObject({ receiptsPaise: R(321000), receiptCount: 5, excluded: { cashPaise: R(5000), cashCount: 1, razorpayPaise: R(45000), razorpayCount: 2, otherAccountsPaise: 0, otherAccountsCount: 0 } });
    expect(v.debits.totalPaise).toBe(R(245000));
    expect(v.debits.lines.find((d) => d.id === "L15")).toMatchObject({ refund: { number: "RF/26-27/0003" }, narration: "IMPS REFUND HUNCH" });
    expect(v.debits.lines.find((d) => d.id === "L31b")?.reversalOf).toBe("reversal of the credit of 14 Oct");
    expect(v.blockers).toEqual([]);
    expect(v.needsAck).toEqual(["open_items"]);
    expect(v.coverage).toMatchObject({ complete: true, gaps: [] });
    // Debit narrations only for sales:approve.
    const redacted = buildBrs({ ...october(), seeDebits: false });
    expect(redacted.debits.lines.every((d) => d.narration === "" && d.redacted)).toBe(true);
  });

  it("B-1b shuffling every input list changes nothing", () => {
    const base = buildBrs(october());
    const rnd = prng(7);
    const shuffle = <T,>(a: T[]) => { const c = [...a]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };
    for (let k = 0; k < 10; k++) {
      const i = october();
      const v = buildBrs({ ...i, lines: shuffle(i.lines), books: shuffle(i.books), statements: shuffle(i.statements), openCredits: shuffle(i.openCredits), unlinked: shuffle(i.unlinked) });
      expect(v).toEqual(base);
    }
  });

  it("B-2 property: 300 random months always tie and every credit paisa lands in exactly one group (R→G)", () => {
    const rnd = prng(20261105);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
    const MODES = ["bank_transfer", "upi", "cheque", "other", "cash", "razorpay"] as const;
    for (let run = 0; run < 300; run++) {
      seq = 0;
      const isDefault = rnd() < 0.7;
      const lines: BrsLineIn[] = [];
      const books: BrsBookReceipt[] = [];
      let rn = 0;
      const mk = (paidOn: string, amt: number, mode: string) => rcpt(`R${run}-${rn++}`, paidOn, amt, mode);
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const day = `2026-10-${String(1 + Math.floor(rnd() * 31)).padStart(2, "0")}`;
        if (rnd() < 0.25) { lines.push(line(day, { dr: 1 + Math.floor(rnd() * 1e6), ignoreReason: rnd() < 0.2 ? "duplicate" : "debit" })); continue; }
        const cr = 100 + Math.floor(rnd() * 5e6);
        const kind = rnd();
        if (kind < 0.25) { lines.push(line(day, { cr, ignoreReason: pick(["interest", "own_transfer", "before_cutover", "duplicate", "other"]) })); continue; }
        const receipts: BrsReceipt[] = [];
        if (kind < 0.85) {
          const parts = 1 + Math.floor(rnd() * 3);
          let left = cr + Math.floor(rnd() * 401) - 200; // rounding, partly matched, over
          if (rnd() < 0.2) left = Math.floor(cr / 2);
          for (let p = 0; p < parts && left > 0; p++) {
            const amt = p === parts - 1 ? left : Math.floor(left / 2);
            left -= amt;
            const inMonth = rnd() < 0.75;
            const paidOn = inMonth ? day : pick(["2026-09-28", "2026-11-02"]);
            receipts.push(mk(paidOn, amt, pick(MODES)));
          }
        }
        const l = line(day, { cr, receipts, possibleDuplicate: rnd() < 0.1 });
        lines.push(l);
        for (const r of receipts) if (r.paidOn.startsWith("2026-10")) books.push(book(r, { lineId: l.id, day }));
      }
      // Books that are not on this month's lines.
      for (let i = 0; i < Math.floor(rnd() * 8); i++) {
        const r = mk(`2026-10-${String(1 + Math.floor(rnd() * 31)).padStart(2, "0")}`, 100 + Math.floor(rnd() * 1e6), pick(MODES));
        const w = rnd();
        books.push(w < 0.3 ? book(r) : w < 0.6 ? book(r, { lineId: "other", account: "acc-other", day: r.paidOn }) : book(r, { lineId: "lnov", day: "2026-11-03" }));
      }
      const input: BrsInput = {
        company: "dspl", account: ACC, defaultAccountId: isDefault ? ACC.id : "acc-other", month: "2026-10", today: "2026-11-20", lines, books,
        statements: [{ id: "st-oct", fileName: "oct.csv", periodFrom: "2026-10-01", periodTo: "2026-10-31", openingPaise: null, closingPaise: null, firstRowDay: null, lastRowDay: null }],
        openCredits: [], unlinked: books.filter((b) => !b.bankLineId), refunds: [], coverageEnd: "2026-10-31", seeDebits: true,
      };
      const v = buildBrs(input);
      expect(v.ties, `run ${run}`).toBe(true);
      for (const l of lines.filter((x) => x.creditPaise > 0 && x.ignoreReason !== "duplicate")) {
        const onLine = v.items.filter((i) => i.line?.id === l.id && i.group !== "credited_other_month").reduce((s, i) => s + i.amountPaise, 0);
        const other = v.items.filter((i) => i.group === "credited_other_month" && i.line?.id === l.id).reduce((s, i) => s + i.amountPaise, 0);
        const inMonth = l.receipts.filter((r) => r.paidOn.startsWith("2026-10")).reduce((s, r) => s + r.amountPaise, 0);
        expect(onLine + other + inMonth, `run ${run} line ${l.id}`).toBe(l.creditPaise);
      }
    }
  });

  it("B-3 day balances: one day ascending and descending give the same start/end; two statements on one day; a line without a balance → unknown (R→G)", () => {
    seq = 0;
    const asc = withBalances([line("2026-10-31", { cr: R(100) }), line("2026-10-31", { dr: R(30) }), line("2026-10-31", { cr: R(50) })], R(1000));
    const stAsc: BrsStatementIn = { id: "st-oct", fileName: "oct.csv", periodFrom: "2026-10-01", periodTo: "2026-10-31", openingPaise: null, closingPaise: null, firstRowDay: "2026-10-01", lastRowDay: "2026-10-31" };
    const a = dayBalances(asc, [stAsc])!;
    // The same lines exported newest first: row numbers reversed, the file runs descending.
    const desc = asc.map((l, i) => ({ ...l, rowNo: 100 - i }));
    const d = dayBalances([...desc].reverse(), [{ ...stAsc, firstRowDay: "2026-10-31", lastRowDay: "2026-10-01" }])!;
    expect(a).toEqual([{ day: "2026-10-31", start: R(1000), end: R(1120), broken: false }]);
    expect(d).toEqual(a);
    // Two statements contributing lines to one day.
    const two = [{ ...asc[0], statementId: "st-a" }, { ...asc[1], statementId: "st-b" }, { ...asc[2], statementId: "st-b" }];
    expect(dayBalances(two, [{ ...stAsc, id: "st-a" }, { ...stAsc, id: "st-b" }])![0]).toMatchObject({ start: R(1000), end: R(1120), broken: false });
    expect(dayBalances([...asc, line("2026-10-31", { cr: 1, bal: null })], [stAsc])).toBeNull();
  });

  it("B-4 integrity: a day break, an equation break, statement opening/closing breaks; a duplicate line is excluded and listed (R→G)", () => {
    const i = october();
    // Day break: shift every balance after 20 Oct by ₹500.
    const shifted = i.lines.map((l) => (l.txnDate > "2026-10-20" ? { ...l, balancePaise: l.balancePaise! + R(500) } : l));
    const v = buildBrs({ ...i, lines: shifted });
    expect(v.balances.breaks.find((b) => b.kind === "day")).toMatchObject({ day: "2026-10-22", expectedPaise: R(402118.4 + 50000 - 40000 + 118000 - 50000 + 108000.4), foundPaise: R(402118.4 + 50000 - 40000 + 118000 - 50000 + 108000.4 + 500) });
    expect(v.balances.breaks.some((b) => b.kind === "statement_close")).toBe(true);
    expect(v.needsAck).toContain("statement_break");
    // Statement opening break.
    const st = i.statements.map((s) => (s.id === "st-oct" ? { ...s, openingPaise: R(1) } : s));
    expect(buildBrs({ ...i, statements: st }).balances.breaks.map((b) => b.kind)).toContain("statement_open");
    // Equation break from statement-only figures (no lines).
    const eq = buildBrs({ ...i, lines: [], books: [], statements: [{ ...i.statements[1], closingPaise: R(5) }] });
    expect(eq.balances.breaks.map((b) => b.kind)).toEqual(["equation"]);
    // A duplicate line: not in credits or the formula, listed under "Stored twice".
    const dup = line("2026-10-14", { id: "Ldup", cr: R(118000), ignoreReason: "duplicate", bal: R(1) });
    const w = buildBrs({ ...i, lines: [...i.lines, dup] });
    expect(w.balances.creditsPaise).toBe(R(633500.4));
    expect(w.ties).toBe(true);
    expect(w.balances.breaks).toEqual([]);
    expect(w.items.find((x) => x.key === "line:Ldup")).toMatchObject({ group: "duplicate", reason: { text: "Stored twice — not counted" } });
  });

  it("B-5 coverage: adjacent statements merge; a gap bridged by equal closing/opening merges; a real gap is listed", () => {
    const s = (id: string, f: string, t: string, o: number | null = null, c: number | null = null): BrsStatementIn => ({ id, fileName: `${id}.csv`, periodFrom: f, periodTo: t, openingPaise: o, closingPaise: c, firstRowDay: null, lastRowDay: null });
    expect(coverageOf([s("a", "2026-10-01", "2026-10-15"), s("b", "2026-10-16", "2026-10-31")], "2026-10-01", "2026-10-31")).toEqual({ touches: true, complete: true, gaps: [] });
    expect(coverageOf([s("a", "2026-10-01", "2026-10-15", 0, 500), s("b", "2026-10-20", "2026-10-31", 500, 900)], "2026-10-01", "2026-10-31").gaps).toEqual([]);
    expect(coverageOf([s("a", "2026-10-01", "2026-10-15", 0, 500), s("b", "2026-10-20", "2026-10-29", 600, 900)], "2026-10-01", "2026-10-31").gaps)
      .toEqual([{ from: "2026-10-16", to: "2026-10-19" }, { from: "2026-10-30", to: "2026-10-31" }]);
    expect(coverageOf([s("a", "2026-09-01", "2026-09-30")], "2026-10-01", "2026-10-31")).toEqual({ touches: false, complete: false, gaps: [{ from: "2026-10-01", to: "2026-10-31" }] });
    // oct.csv stops on 29 Oct; nov.csv's opening differs from oct.csv's closing, so money moved in the gap.
    const v = buildBrs({ ...october(), statements: october().statements.map((x) => (x.id === "st-oct" ? { ...x, periodTo: "2026-10-29" } : x.id === "st-nov" ? { ...x, openingPaise: R(1) } : x)) });
    // With equal closing/opening the same gap is bridged (no money moved).
    expect(buildBrs({ ...october(), statements: october().statements.map((x) => (x.id === "st-oct" ? { ...x, periodTo: "2026-10-29" } : x)) }).coverage.gaps).toEqual([]);
    expect(v.coverage.gaps).toEqual([{ from: "2026-10-30", to: "2026-10-31" }]);
    expect(v.needsAck).toContain("coverage_gap");
    expect(v.todo[0].sentence).toBe("Upload the statement for 30–31 Oct");
  });

  it("B-6 fallback balances from statements; a typed closing → opening = typed − credits + debits", () => {
    const i = october();
    const noBal = i.lines.map((l) => ({ ...l, balancePaise: null }));
    const v = buildBrs({ ...i, lines: noBal });
    expect(v.balances).toMatchObject({ source: "statement", openingPaise: R(402118.4), closingPaise: R(790618.8) });
    const unknown = buildBrs({ ...i, lines: noBal, statements: i.statements.map((s) => ({ ...s, openingPaise: null, closingPaise: null })) });
    expect(unknown.balances).toMatchObject({ source: "unknown", openingPaise: null, closingPaise: null });
    expect(unknown.needsAck).toContain("typed_closing");
    const typed = buildBrs({ ...i, lines: noBal, statements: i.statements.map((s) => ({ ...s, openingPaise: null, closingPaise: null })), typedClosingPaise: R(790618.8) });
    expect(typed.balances).toMatchObject({ source: "typed", closingPaise: R(790618.8), openingPaise: R(402118.4) });
  });

  it("B-6b one printed balance is not enough: opening only → unknown + typed_closing; a typed closing is then checked against it and against last month's sign-off (R→G)", () => {
    const i = october();
    const noBal = i.lines.map((l) => ({ ...l, balancePaise: null }));
    // A CSV without a balance column: opening from the preamble, closing null; or a period running past the month.
    const openOnly = i.statements.map((s) => (s.id === "st-oct" ? { ...s, closingPaise: null } : s));
    const v = buildBrs({ ...i, lines: noBal, statements: openOnly });
    expect(v.balances).toMatchObject({ source: "unknown", openingPaise: null, closingPaise: null, agreesWith: null });
    expect(v.needsAck).toContain("typed_closing");
    const past = buildBrs({ ...i, lines: noBal, statements: [{ ...i.statements[1], periodTo: "2026-11-15", closingPaise: null }] });
    expect(past.balances).toMatchObject({ source: "unknown", agreesWith: null });
    // Typed: agrees with the printed opening → no break, but nothing printed a closing to agree with.
    const ok = buildBrs({ ...i, lines: noBal, statements: openOnly, typedClosingPaise: R(790618.8) });
    expect(ok.balances).toMatchObject({ source: "typed", openingPaise: R(402118.4), breaks: [], agreesWith: null });
    // A typing slip: the worked-back opening no longer meets the printed one.
    const slip = buildBrs({ ...i, lines: noBal, statements: openOnly, typedClosingPaise: R(790618.8) + R(100) });
    expect(slip.balances.breaks).toEqual([expect.objectContaining({ kind: "statement_open", fileName: "oct.csv", expectedPaise: R(402118.4), foundPaise: R(402218.4) })]);
    expect(slip.needsAck).toContain("statement_break");
    // Closing only printed → typed and equal → agrees with that file (it was compared).
    const closeOnly = i.statements.map((s) => (s.id === "st-oct" ? { ...s, openingPaise: null } : s));
    expect(buildBrs({ ...i, lines: noBal, statements: closeOnly }).balances.source).toBe("unknown");
    expect(buildBrs({ ...i, lines: noBal, statements: closeOnly, typedClosingPaise: R(790618.8) }).balances).toMatchObject({ source: "typed", agreesWith: "oct.csv", breaks: [] });
    // Last month's signed-off closing is checked against the worked-back opening.
    const none = i.statements.map((s) => ({ ...s, openingPaise: null, closingPaise: null }));
    const prevOk = buildBrs({ ...i, lines: noBal, statements: none, typedClosingPaise: R(790618.8), previousSignedClosingPaise: R(402118.4) });
    expect(prevOk.balances.breaks).toEqual([]);
    const prevBad = buildBrs({ ...i, lines: noBal, statements: none, typedClosingPaise: R(790618.8), previousSignedClosingPaise: R(400000) });
    expect(prevBad.balances.breaks).toEqual([expect.objectContaining({ kind: "statement_open", expectedPaise: R(400000), foundPaise: R(402118.4) })]);
    expect(prevBad.balances.breaks[0].text).toMatch(/^Last month was signed off with a closing balance of ₹4,00,000\.00/);
    // A statement with balances that the lines agree with: "Agrees with" only when its closing equals ours.
    expect(buildBrs(i).balances.agreesWith).toBe("oct.csv");
    expect(buildBrs({ ...i, statements: i.statements.map((s) => (s.id === "st-oct" ? { ...s, closingPaise: null } : s)) }).balances.agreesWith).toBeNull();
  });

  it("B-6c a bank statement's side: Cr is money in the account (positive), Dr is overdrawn", () => {
    expect(bankBalanceFromSide(R(790618.8), "Cr")).toBe(R(790618.8));
    expect(bankBalanceFromSide(R(790618.8), "Dr")).toBe(-R(790618.8));
    expect(bankBalanceFromSide(0, "Cr")).toBe(0);
  });

  it("B-7 attribution: default account counts unlinked bank-mode receipts; another account lists them as a memo; a linked cash receipt counts", () => {
    const i = october();
    const other = buildBrs({ ...i, defaultAccountId: "acc-icici" });
    // RCPT/0043 (unlinked cheque) belongs to the default account now.
    expect(other.items.some((x) => x.key === "nc:p-RCPT/26-27/0043")).toBe(false);
    expect(other.books.excluded).toMatchObject({ otherAccountsCount: 1, otherAccountsPaise: R(25000) });
    expect(other.ties).toBe(true);
    // A cash receipt linked to a line was banked: it counts.
    const cash = rcpt("RCPT/26-27/0050", "2026-10-28", R(40000), "cash");
    const linked = buildBrs({ ...i, lines: i.lines.map((l) => (l.id === "L28" ? { ...l, receipts: [cash] } : l)), books: [...i.books, book(cash, { lineId: "L28", day: "2026-10-28" })] });
    expect(linked.books.receiptsPaise).toBe(R(361000));
    expect(linked.items.some((x) => x.key === "line:L28")).toBe(false);
    expect(linked.ties).toBe(true);
    // A receipt linked to another account's line → memo.
    const elsewhere = buildBrs({ ...i, books: [...i.books, book(rcpt("RCPT/26-27/0051", "2026-10-11", R(7000)), { lineId: "x", account: "acc-icici", day: "2026-10-11" })] });
    expect(elsewhere.books.excluded.otherAccountsPaise).toBe(R(7000));
  });

  it("B-8 unlinked-receipt reason order; a candidate is offered to one item only", () => {
    const i = october();
    const a = rcpt("RCPT/A", "2026-10-27", R(40000)), b = rcpt("RCPT/B", "2026-10-29", R(40000));
    const v = buildBrs({ ...i, books: [...i.books, book(a), book(b)], unlinked: [...i.unlinked, a, b] });
    // The 28 Oct ₹40,000 credit is offered RCPT/A (first in order); RCPT/A is offered the credit back; RCPT/B gets nothing to link.
    expect(v.items.find((x) => x.key === "line:L28")).toMatchObject({ reason: { code: "RECEIPT_FITS" }, link: { lineId: "L28", paymentId: "p-RCPT/A" } });
    expect(v.items.find((x) => x.key === "nc:p-RCPT/A")).toMatchObject({ reason: { code: "CREDIT_FITS" }, link: { lineId: "L28", paymentId: "p-RCPT/A" } });
    expect(v.items.find((x) => x.key === "nc:p-RCPT/B")!.reason.code).not.toBe("CREDIT_FITS");
    // Order: before cut-over wins over everything.
    const early = buildBrs({ ...i, account: { ...ACC, matchFrom: "2026-11-01" } });
    expect(early.items.find((x) => x.key === "nc:p-RCPT/26-27/0043")!.reason.code).toBe("BEFORE_CUTOVER");
    // Not uploaded yet: coverage ends before paid_on + 3.
    expect(buildBrs({ ...i, coverageEnd: "2026-10-30" }).items.find((x) => x.key === "nc:p-RCPT/26-27/0043")!.reason.code).toBe("NOT_UPLOADED_YET");
    // A non-cheque receipt with coverage well past it: not on the statement.
    const upi = rcpt("RCPT/U", "2026-10-03", R(1234), "upi");
    expect(buildBrs({ ...i, books: [...i.books, book(upi)] }).items.find((x) => x.key === "nc:p-RCPT/U")).toMatchObject({ reason: { code: "NOT_ON_STATEMENT" }, open: true });
    // Unmatched reasons: possible duplicate and a stored suggestion.
    const dup = buildBrs({ ...i, lines: i.lines.map((l) => (l.id === "L28" ? { ...l, possibleDuplicate: true } : l)) });
    expect(dup.items.find((x) => x.key === "line:L28")!.reason.code).toBe("POSSIBLE_DUPLICATE");
    const sug = buildBrs({ ...i, lines: i.lines.map((l) => (l.id === "L28" ? { ...l, confidence: "high", suggestion: { v: 1, candidates: [{ kind: "invoice", allocations: [{ number: "INV/26-27/0019" }] }] } } : l)) });
    expect(sug.items.find((x) => x.key === "line:L28")!.reason).toMatchObject({ code: "SUGGESTED", text: "Bank suggests INV/26-27/0019 — confirm it on Bank" });
  });

  it("B-8b a receipt linked to a line stored twice in ANOTHER month was never credited: an open item, not a closed timing item (R→G)", () => {
    const i = october();
    const v = buildBrs({ ...i, books: i.books.map((b) => (b.id === "p-RCPT/26-27/0044" ? { ...b, lineIsDuplicate: true } : b)) });
    expect(v.items.find((x) => x.key === "nc:p-RCPT/26-27/0044")).toMatchObject({ group: "not_credited", open: true, reason: { code: "ON_UNCOUNTED_LINE" } });
    expect(v.openItems).toEqual({ count: 4, paise: R(130000) });
    expect(v.ties).toBe(true);
  });

  it("B-8c who ignored a line, and when, is the IST day (an ignore at 01:30 IST is that day, not yesterday)", () => {
    const i = october();
    const v = buildBrs({ ...i, lines: i.lines.map((l) => (l.id === "L22" ? { ...l, ignoredAt: "2026-11-02T20:00:00.000Z" } : l)) });
    expect(v.items.find((x) => x.key === "line:L22")!.reason.text).toContain("Riya Shah, 3 Nov 2026");
  });

  it("B-11 the PDF prints no glyph Helvetica lacks: ₹ → Rs., − → -", async () => {
    const i = october();
    const eq = buildBrs({ ...i, lines: [], books: [], statements: [{ ...i.statements[1], closingPaise: R(5) }] });
    expect(eq.balances.breaks[0].text).toContain("−");
    const pdf = await renderBrsPdf(eq, { frozen: false, redactDebits: false, seller: { legalName: "Digital Sukoon Private Limited", gstins: [], address: "" }, signoff: null });
    const text = pdfText(pdf);
    expect(text).toContain("credits - withdrawals");
    expect(text).toContain("Rs. ");
  });

  it("B-9 over-matched credit → item + blocker BRS_OVER_MATCHED", () => {
    const i = october();
    const v = buildBrs({ ...i, lines: i.lines.map((l) => (l.id === "L28" ? { ...l, receipts: [rcpt("RCPT/X", "2026-10-28", R(45000))] } : l)), books: [...i.books, book(rcpt("RCPT/X", "2026-10-28", R(45000)), { lineId: "L28", day: "2026-10-28" })] });
    expect(v.items.find((x) => x.key === "line:L28")).toMatchObject({ group: "over_matched", amountPaise: -R(5000) });
    expect(v.blockers.map((b) => b.code)).toContain("BRS_OVER_MATCHED");
    expect(v.ties).toBe(true);
  });

  it("B-10 month state and the change diff", () => {
    expect(brsState({ monthTo: "2026-11-30", today: "2026-11-05", activeFingerprint: null, liveFingerprint: "a" })).toBe("running");
    expect(brsState({ monthTo: "2026-10-31", today: "2026-11-05", activeFingerprint: null, liveFingerprint: "a" })).toBe("open");
    expect(brsState({ monthTo: "2026-10-31", today: "2026-11-05", activeFingerprint: "a", liveFingerprint: "a" })).toBe("reconciled");
    expect(brsState({ monthTo: "2026-10-31", today: "2026-11-05", activeFingerprint: "a", liveFingerprint: "b" })).toBe("changed");
    const frozen = buildBrs(october());
    const i = october();
    const live = buildBrs({ ...i, lines: [...i.lines, line("2026-10-30", { id: "Lnew", cr: R(1000), bal: null })] });
    const d = brsChanges(frozen, live);
    expect(d.added.map((x) => x.key)).toEqual(["line:Lnew"]);
    expect(d.removed).toEqual([]);
    expect(d.figures.map((f) => f.key)).toEqual(expect.arrayContaining(["credits", "unmatched"]));
    expect(buildBrs({ ...i, today: "2026-10-31" }).blockers[0]).toMatchObject({ code: "MONTH_NOT_OVER", sentence: "October 2026 isn't over yet — it can be reconciled from 1 Nov 2026." });
    expect(monthBounds("2026-12")).toMatchObject({ from: "2026-12-01", to: "2026-12-31", next: "2027-01-01", label: "December 2026" });
  });
});

function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  let text = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) text += Buffer.from(h[1], "hex").toString("latin1");
    text += " ";
  }
  return text;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
