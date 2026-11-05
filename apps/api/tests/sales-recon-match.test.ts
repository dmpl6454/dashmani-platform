/**
 * Reconcile matchers (spec-reconcile §5, §10.2): TDS vs 26AS (T-1…T-13), GSTR-1 vs books (G-1…G-13),
 * the client ledger (L-1…L-4). Pure — no DB, no clock.
 */
import { describe, it, expect } from "vitest";
import { matchTds, resolveTans, type TdsBookItem, type TdsEntryIn, type TanResolution } from "../src/services/sales/recon/match-tds";
import { matchGstr1, type BookDoc, type FiledIn } from "../src/services/sales/recon/match-gstr1";
import { buildLedger, type LedgerStatement } from "../src/services/sales/recon/ledger";
import { parse26asText } from "../src/services/sales/recon/parse-26as";
import { parseGstr1Json } from "../src/services/sales/recon/parse-gstr1";
import { SAMPLE_26AS, gstr1OctoberJson } from "./recon-fixtures";

const R = (rupees: number) => Math.round(rupees * 100);
const FY = "2025-26";
const AS_ON = "2026-11-05";

// ─── TDS fixture (§5.1.7) ────────────────────────────────────────────────────────────────────
const C = { filmy: "c-filmy", kanara: "c-kanara", hunch: "c-hunch", moon: "c-moon", red: "c-red" };
const CLIENTS = [
  { id: C.filmy, companyName: "Filmy Brands", legalName: "Filmy Brands Pvt. Ltd." },
  { id: C.kanara, companyName: "Kanara Foods", legalName: "Kanara Foods Private Limited" },
  { id: C.hunch, companyName: "Hunch Media", legalName: "Hunch Media LLP" },
  { id: C.moon, companyName: "Moonlight Studios", legalName: "Moonlight Studios" },
  { id: C.red, companyName: "Red Chilli", legalName: "Red Chilli Entertainment Private Limited" },
];
const clientInfo = CLIENTS.map((c) => ({ id: c.id, name: c.companyName, legalName: c.legalName, pan: null, billingEmail: null }));
function item(key: string, clientId: string, inv: string, issue: string, taxable: number, total: number, rcpt: string, paid: string, cash: number, tds: number): TdsBookItem {
  return { key, paymentId: `p-${key}`, receiptNumber: rcpt, paidOn: paid, clientId, invoiceId: `i-${key}`, invoiceNumber: inv, invoiceKind: "tax_invoice", issueDate: issue,
    taxablePaise: R(taxable), totalPaise: R(total), amountPaise: R(cash), tdsPaise: R(tds), t2: false };
}
const BOOKS: TdsBookItem[] = [
  item("B1", C.filmy, "INV/25-26/0101", "2025-09-20", 100000, 118000, "RCPT/25-26/0031", "2025-10-03", 108000, 10000),
  item("B2", C.filmy, "INV/25-26/0130", "2025-12-01", 50000, 59000, "RCPT/25-26/0044", "2025-12-15", 54000, 5000),
  item("B3", C.kanara, "INV/25-26/0140", "2025-12-22", 200000, 236000, "RCPT/25-26/0050", "2026-01-10", 232000, 4000),
  item("B4", C.hunch, "INV/25-26/0150", "2026-02-05", 50000, 59000, "RCPT/25-26/0060", "2026-02-14", 57820, 1180),
  item("B5", C.moon, "INV/25-26/0160", "2026-03-02", 30000, 35400, "RCPT/25-26/0070", "2026-03-20", 32400, 3000),
  item("B6", C.filmy, "INV/25-26/0170", "2026-03-25", 40000, 47200, "RCPT/26-27/0005", "2026-04-12", 43200, 4000),
];
const ENTRIES: TdsEntryIn[] = parse26asText(SAMPLE_26AS).items.map((e, i) => ({ ...e, id: `e${i + 1}` }));
const BASE_DEDUCTORS = [{ tan: "MUMH03189E", kind: "non_sales", clientId: null, label: "Bank interest — HDFC FD", source: "manual" }];

function run(opts: { profiles?: Array<{ tan: string; clientId: string }>; deductors?: typeof BASE_DEDUCTORS; entries?: TdsEntryIn[]; items?: TdsBookItem[]; asOn?: string; fy?: string } = {}) {
  const entries = opts.entries ?? ENTRIES;
  const items = opts.items ?? BOOKS;
  const fy = opts.fy ?? FY;
  const tans = resolveTans({ fy, entries, items, profiles: opts.profiles ?? [], deductors: opts.deductors ?? BASE_DEDUCTORS, clients: CLIENTS });
  return { tans, m: matchTds({ fy, asOn: opts.asOn ?? AS_ON, ourPan: "AAKCD3352K", entries, items, tans, clients: clientInfo }) };
}
const LEARNED = [{ tan: "MUMF12345A", clientId: C.filmy }, { tan: "BLRK98765C", clientId: C.kanara }];
const TAPPED = [...BASE_DEDUCTORS, { tan: "DELH55555E", kind: "client", clientId: C.hunch, label: null, source: "manual" }, { tan: "DELR77777Z", kind: "client", clientId: C.red, label: null, source: "manual" }];

describe("TDS vs 26AS", () => {
  it("T-1 the §5.1.7 example — proposals, before and after the two taps", () => {
    const first = run();
    const byTan = (t: TanResolution[], tan: string) => t.find((x) => x.tan === tan)!;
    expect(byTan(first.tans, "MUMF12345A").proposal).toMatchObject({ clientId: C.filmy, sure: true });
    expect(byTan(first.tans, "BLRK98765C").proposal).toMatchObject({ clientId: C.kanara, sure: true });
    expect(byTan(first.tans, "DELH55555E").proposal).toMatchObject({ clientId: C.hunch, sure: false });
    expect(byTan(first.tans, "DELR77777Z").proposal).toMatchObject({ clientId: C.red, sure: false });
    expect(byTan(first.tans, "MUMS11111B").proposal).toBeNull();
    expect(byTan(first.tans, "MUMH03189E").kind).toBe("non_sales");

    const before = run({ profiles: LEARNED });
    expect(before.m.totals.chasePaise).toBe(R(7000));
    expect(before.m.rows.find((r) => r.group === "link_first")).toMatchObject({ clientId: C.hunch, quarter: 4, booksPaise: R(1180) });

    const after = run({ profiles: LEARNED, deductors: TAPPED });
    expect(after.m.totals).toEqual({
      booksPaise: R(27180), deductedPaise: R(31750), depositedPaise: R(27750), matchedPaise: R(19000), chasePaise: R(7180), chaseCount: 3,
      extraPaise: R(8000), unknownPaise: R(2500), nonSalesPaise: R(1250), notDuePaise: 0, nextYearPaise: R(4000), linkFirstPaise: 0,
    });
    const chase = after.m.rows.filter((r) => r.group === "chase");
    expect(chase.map((r) => [r.clientId, r.reason.code, r.differencePaise])).toEqual([
      [C.hunch, "short", R(180)], [C.kanara, "status_U", R(4000)], [C.moon, "not_in_26as", R(3000)],
    ]);
    expect(chase.find((r) => r.clientId === C.kanara)!.flags).toEqual(["status_U", "short_deposited"]);
    expect(chase.find((r) => r.clientId === C.hunch)!.reason.text).toBe("Our receipts show ₹1,180.00 TDS for Q4; Form 26AS shows ₹1,000.00 — please revise your Q4 return for the ₹180.00 difference, or pay it to us.");
    expect(chase.find((r) => r.clientId === C.moon)!.reason.text).toContain("TDS ₹3,000.00 deducted on INV/25-26/0160 (RCPT/25-26/0070, 20 Mar 2026, Q4) is not in our Form 26AS");
    expect(after.m.rows.filter((r) => r.group === "matched").map((r) => r.items.map((i) => i.key).join("+")).sort()).toEqual(["B1", "B2", "B3"]);
    expect(after.m.rows.find((r) => r.group === "next_year")).toMatchObject({ clientId: C.filmy, booksPaise: R(4000) });
    expect(after.m.rows.find((r) => r.group === "extra")).toMatchObject({ clientId: C.red, form26Paise: R(8000) });
    expect(after.m.rows.find((r) => r.group === "unknown")).toMatchObject({ tan: "MUMS11111B", form26Paise: R(2500) });
    expect(after.m.rows.find((r) => r.group === "non_sales")).toMatchObject({ tan: "MUMH03189E", form26Paise: R(1250) });
    expect(after.m.expectedBy.every((e) => e.due)).toBe(true);
  });

  it("T-2 a 26AS entry on the invoice date pairs with an invoice of Q2 paid in Q3 (books homed on the invoice date)", () => {
    const b = item("X", C.filmy, "INV/1", "2025-09-20", 100000, 118000, "RCPT/1", "2025-10-30", 108000, 10000);
    const e: TdsEntryIn = { ...ENTRIES[0], id: "x1" };
    const { m } = run({ profiles: LEARNED, entries: [e], items: [b] });
    expect(m.rows.map((r) => r.group)).toEqual(["matched"]);
    expect(m.totals.chasePaise).toBe(0);
  });

  it("T-3 the taxable base ranks before the total; only the total fitting → on_gross", () => {
    const e: TdsEntryIn = { ...ENTRIES[0], id: "x1", amountPaidPaise: R(118000), tdsPaise: R(10000) };
    const onGross = run({ profiles: LEARNED, entries: [e], items: [item("A", C.filmy, "INV/1", "2025-09-20", 100000, 118000, "R/1", "2025-10-03", 108000, 10000)] });
    expect(onGross.m.rows[0].flags).toContain("on_gross");
    const e2: TdsEntryIn = { ...e, amountPaidPaise: R(100000) };
    const two = [item("A", C.filmy, "INV/1", "2025-09-20", 84746, 100000, "R/1", "2025-10-03", 90000, 10000), item("B", C.filmy, "INV/2", "2025-09-20", 100000, 118000, "R/2", "2025-10-03", 108000, 10000)];
    const r = run({ profiles: LEARNED, entries: [e2], items: two });
    expect(r.m.rows.find((x) => x.group === "matched")!.items[0].key).toBe("B");
  });

  it("T-4 stage 1b: one entry of ₹10,000 against part receipts of ₹6,000 + ₹4,000 on one invoice", () => {
    const a = { ...item("P1", C.filmy, "INV/1", "2025-09-20", 100000, 118000, "R/1", "2025-09-25", 64800, 6000), invoiceId: "inv1" };
    const b = { ...item("P2", C.filmy, "INV/1", "2025-09-20", 100000, 118000, "R/2", "2025-10-01", 43200, 4000), invoiceId: "inv1" };
    const { m } = run({ profiles: LEARNED, entries: [{ ...ENTRIES[0], id: "x1" }], items: [a, b] });
    const pair = m.rows.find((r) => r.group === "matched")!;
    expect(pair.flags).toContain("many_receipts");
    expect(pair.items.map((i) => i.key).sort()).toEqual(["P1", "P2"]);
  });

  it("T-5 tolerance: 100 paise pairs, 101 does not; a quarter cell with 3 entries allows 300", () => {
    const b = item("A", C.filmy, "INV/1", "2025-09-20", 100000, 118000, "R/1", "2025-10-03", 108000, 10000);
    const at = (d: number) => run({ profiles: LEARNED, entries: [{ ...ENTRIES[0], id: "x", tdsPaise: R(10000) + d }], items: [b] }).m.rows.filter((r) => r.group === "matched" && r.key.startsWith("pair:")).length;
    expect(at(100)).toBe(1);
    expect(at(101)).toBe(0);
    const es = [1, 2, 3].map((k) => ({ ...ENTRIES[0], id: `y${k}`, rowNo: k, txnDate: "2025-08-01", quarter: 2 as const, tdsPaise: R(1000) }));
    const books = [item("Q", C.filmy, "INV/9", "2025-07-01", 1, 1, "R/9", "2025-07-01", 0, 3000)];
    books[0].tdsPaise = R(3000) + 299;
    const cell = run({ profiles: LEARNED, entries: es, items: books }).m.rows.find((r) => r.key === `cell:${C.filmy}:2`)!;
    expect(cell.reason.code).toBe("matched_split");
  });

  it("T-6 not due: a Q3 item with as-on 6 Nov 2026 is not chased; as-on 16 Feb 2027 it is", () => {
    const b = item("A", C.moon, "INV/1", "2026-10-10", 30000, 35400, "R/1", "2026-10-20", 32400, 3000);
    const early = run({ fy: "2026-27", entries: [], items: [b], asOn: "2026-11-06" }).m;
    expect(early.rows[0].group).toBe("not_due");
    expect(early.totals.chasePaise).toBe(0);
    const late = run({ fy: "2026-27", entries: [], items: [b], asOn: "2027-02-16" }).m;
    expect(late.rows[0]).toMatchObject({ group: "chase" });
    expect(late.totals.chasePaise).toBe(R(3000));
  });

  it("T-7 next year never chased; a 25 Mar entry pairs it; a boundary item pairs but is never counted or listed", () => {
    const b6 = BOOKS[5];
    expect(run({ profiles: LEARNED, entries: [], items: [b6] }).m.rows.map((r) => r.group)).toEqual(["next_year"]);
    const e: TdsEntryIn = { ...ENTRIES[0], id: "x", txnDate: "2026-03-25", quarter: 4, amountPaidPaise: R(40000), tdsPaise: R(4000) };
    expect(run({ profiles: LEARNED, entries: [e], items: [b6] }).m.rows.map((r) => r.group)).toEqual(["matched"]);
    const boundary = item("BD", C.filmy, "INV/24-25/9", "2025-03-28", 40000, 47200, "R/9", "2025-04-05", 43200, 4000);
    const eb: TdsEntryIn = { ...ENTRIES[0], id: "xb", txnDate: "2025-04-05", quarter: 1, amountPaidPaise: R(40000), tdsPaise: R(4000) };
    const paired = run({ profiles: LEARNED, entries: [eb], items: [boundary] }).m;
    expect(paired.rows.map((r) => r.group)).toEqual(["matched"]);
    expect(paired.totals.booksPaise).toBe(0);
    expect(run({ profiles: LEARNED, entries: [], items: [boundary] }).m.rows).toEqual([]);
  });

  it("T-8 booking U and O → chase; P → shown, not chased; F deposited short → short_deposited", () => {
    const e = (id: string, st: string, dep: number | null) => ({ ...ENTRIES[0], id, rowNo: Number(id.slice(1)), bookingStatus: st, depositedPaise: dep });
    const { m } = run({ profiles: LEARNED, entries: [e("e1", "U", 0), e("e2", "O", R(10000)), e("e3", "P", R(10000)), e("e4", "F", R(7000))], items: [] });
    const codes = m.rows.filter((r) => r.group === "chase").map((r) => r.reason.code).sort();
    expect(codes).toEqual(["short_deposited", "status_O", "status_U"]);
    expect(m.rows.filter((r) => r.group === "status_p")).toHaveLength(1);
    expect(m.rows.find((r) => r.reason.code === "short_deposited")!.differencePaise).toBe(R(3000));
  });

  it("T-9 resolveTans: profile first, then a deductors row; sure = name + fit + no rival", () => {
    const one = (entries: TdsEntryIn[], items: TdsBookItem[], extra: Partial<Parameters<typeof resolveTans>[0]> = {}) =>
      resolveTans({ fy: FY, entries, items, profiles: [], deductors: [], clients: CLIENTS, ...extra })[0];
    const e = { ...ENTRIES[0], id: "x" };
    expect(one([e], [], { profiles: [{ tan: e.tan, clientId: C.moon }], deductors: [{ tan: e.tan, kind: "client", clientId: C.red, label: null, source: "manual" }] })).toMatchObject({ kind: "client", clientId: C.moon, source: "profile" });
    expect(one([e], [], { deductors: [{ tan: e.tan, kind: "client", clientId: C.red, label: null, source: "auto" }] })).toMatchObject({ clientId: C.red, source: "auto" });
    expect(one([e], []).proposal).toMatchObject({ clientId: C.filmy, sure: false });
    expect(one([e], [BOOKS[0]]).proposal).toMatchObject({ clientId: C.filmy, sure: true });
    const rival = { ...BOOKS[0], key: "RIV", clientId: C.moon };
    expect(one([e], [BOOKS[0], rival]).proposal).toMatchObject({ clientId: C.filmy, sure: false });
    expect(one([{ ...e, deductorName: "FILMY" }], [BOOKS[0]]).proposal).toMatchObject({ clientId: C.filmy, sure: false });
  });

  it("T-10 a non-sales TAN is never extra or chased; an unknown is listed with its proposal", () => {
    const { m } = run({ profiles: LEARNED });
    expect(m.rows.filter((r) => r.tan === "MUMH03189E").map((r) => r.group)).toEqual(["non_sales"]);
    expect(m.rows.find((r) => r.tan === "DELR77777Z")).toMatchObject({ group: "unknown", clientId: C.red });
  });

  it("T-11 a T2 item is homed on paid_on, amount evidence rank 2", () => {
    const t2: TdsBookItem = { key: "pay:x", paymentId: "x", receiptNumber: "R/x", paidOn: "2026-01-20", clientId: C.filmy, invoiceId: null, invoiceNumber: null, invoiceKind: null, issueDate: null, taxablePaise: null, totalPaise: null, amountPaise: null, tdsPaise: R(500), t2: true };
    const { m } = run({ profiles: LEARNED, entries: [], items: [t2], asOn: "2027-01-01" });
    expect(m.rows[0]).toMatchObject({ group: "chase", quarter: 4 });
    expect(m.rows[0].items[0].homeDay).toBe("2026-01-20");
  });

  it("T-12 shuffled entries and items → deep-equal output", () => {
    const a = run({ profiles: LEARNED, deductors: TAPPED });
    const b = run({ profiles: [...LEARNED].reverse(), deductors: [...TAPPED].reverse(), entries: [...ENTRIES].reverse(), items: [...BOOKS].reverse() });
    expect(b.m).toEqual(a.m);
    expect(b.tans).toEqual(a.tans);
  });

  it("T-13 section_hint when 26AS's section disagrees with the rate (info only)", () => {
    const e: TdsEntryIn = { ...ENTRIES[0], id: "x", section: "194C" };
    const { m } = run({ profiles: LEARNED, entries: [e], items: [BOOKS[0]] });
    expect(m.rows[0]).toMatchObject({ group: "matched" });
    expect(m.rows[0].flags).toContain("section_hint");
  });
});

// ─── GST fixture (§5.2.3) ────────────────────────────────────────────────────────────────────
function bdoc(id: string, number: string, date: string, buyer: string | null, taxable: number, h: { i?: number; c?: number; s?: number }, extra: Partial<BookDoc> = {}): BookDoc {
  const igst = R(h.i ?? 0), cgst = R(h.c ?? 0), sgst = R(h.s ?? 0);
  return { id, kind: "invoice", number, status: "issued", date, cancelledOn: null, buyerGstin: buyer, buyerName: "x", pos: buyer ? buyer.slice(0, 2) : "27", section: buyer ? "b2b" : "b2cs",
    valuePaise: R(taxable) + igst + cgst + sgst, taxablePaise: R(taxable), igstPaise: igst, cgstPaise: cgst, sgstPaise: sgst, ratesBp: [1800], invoiceNumber: null, invoiceId: null, ...extra };
}
const FILMY = "27AABCU9603R1ZX", KANARA = "29AAACB1234F1Z9";
const GBOOKS: BookDoc[] = [
  bdoc("i14", "INV/26-27/0014", "2026-09-30", FILMY, 20000, { c: 1800, s: 1800 }),
  bdoc("i16", "INV/26-27/0016", "2026-10-14", FILMY, 100000, { c: 9000, s: 9000 }),
  bdoc("i17", "INV/26-27/0017", "2026-10-22", KANARA, 200000, { i: 36000 }),
  bdoc("i18", "INV/26-27/0018", "2026-10-28", FILMY, 50000, { c: 4500, s: 4500 }),
  bdoc("i19", "INV/26-27/0019", "2026-10-31", KANARA, 30000, { i: 5400 }),
  bdoc("i22", "INV/26-27/0022", "2026-10-26", "27AAJFO1111K1Z5", 5000, { c: 450, s: 450 }, { status: "cancelled", cancelledOn: "2026-10-27" }),
  bdoc("cn3", "CN/26-27/0003", "2026-10-30", KANARA, 20000, { i: 3600 }, { kind: "credit_note", invoiceNumber: "INV/26-27/0017", invoiceId: "i17" }),
];
const PERIOD = { key: "2026-10", label: "October 2026", from: "2026-10-01", toExclusive: "2026-11-01" };
const filedOf = (json: unknown): FiledIn[] => parseGstr1Json(json).items.map((d, k) => ({ ...d, id: `f${k}`, uploadId: "u1" }));
const GURUGRAM = [{ key0: "INV/26-27/061", kind: "registration" as const, number: "INV/26-27/061", invoiceId: "g61", companyKey: "dspl", gstin: "06AAKCD3352K1ZJ", label: "Gurugram" }];
function gst(over: Partial<Parameters<typeof matchGstr1>[0]> = {}) {
  return matchGstr1({ gstin: "27AAKCD3352K1ZF", period: PERIOD, books: GBOOKS, filed: filedOf(gstr1OctoberJson()), elsewhere: GURUGRAM, otherPeriods: [], nextPeriod: { label: "November 2026", uploaded: false }, filedOther: {}, ...over });
}
const statusOf = (m: ReturnType<typeof gst>, number: string) => m.rows.find((r) => r.books?.number === number || r.filed?.number === number)!;

describe("GST books vs GSTR-1", () => {
  it("G-1 the §5.2.3 example — every row and the counts", () => {
    const m = gst();
    expect(statusOf(m, "INV/26-27/0016").status).toBe("matched_note");
    expect(statusOf(m, "INV/26-27/0017").status).toBe("wrong_recipient");
    const r18 = statusOf(m, "INV/26-27/0018");
    expect(r18.status).toBe("value_mismatch");
    expect(r18.issues.filter((i) => i.code === "value_mismatch").map((i) => [i.message.split(":")[0], i.differencePaise])).toEqual([["Taxable", R(5000)], ["CGST", R(450)], ["SGST", R(450)], ["Value", R(5900)]]);
    expect(statusOf(m, "INV/26-27/0014").status).toBe("wrong_period");
    expect(statusOf(m, "INV/26-27/0022").status).toBe("cancelled_but_filed");
    expect(statusOf(m, "DSPL/26-27/0155")).toMatchObject({ status: "not_in_books", hint: { importable: true } });
    expect(statusOf(m, "INV/26-27/061").hint!.text).toBe("Issued from Gurugram (06AAKCD3352K1ZJ) — filed under the wrong registration.");
    expect(statusOf(m, "CN/26-27/0003").status).toBe("matched");
    const r19 = statusOf(m, "INV/26-27/0019");
    expect(r19.status).toBe("not_filed");
    expect(r19.issues[0].message).toContain("November 2026's GSTR-1 is not uploaded here — it may be there");
    const { cancelledNotFiled, ...counts } = m.counts;
    expect(counts).toEqual({ matched: 1, matched_note: 1, value_mismatch: 1, wrong_recipient: 1, wrong_period: 1, not_filed: 1, not_in_books: 2, cancelled_but_filed: 1 });
    expect(cancelledNotFiled).toBe(0);
    expect(m.importable).toBe(true);
  });

  it("G-2 filed INV/26-27/016 ↔ books INV/26-27/0016 → matched_note naming the filed number", () => {
    expect(statusOf(gst(), "INV/26-27/0016").issues).toEqual([{ code: "number_written_differently", message: "Filed as INV/26-27/016." }]);
  });

  it("G-3 Mumbai/Gurugram trap: keys never cross GSTINs", () => {
    // The 27 file's INV/26-27/016 matches 27's 0016 only — the 06 invoice is never in these books.
    const m = gst();
    expect(statusOf(m, "INV/26-27/0016").filed!.number).toBe("INV/26-27/016");
    // A number that exists only under 06 → hint by key0, never a match.
    const only06 = gst({ books: GBOOKS.filter((b) => b.id !== "i16") });
    const r = only06.rows.find((x) => x.filed?.number === "INV/26-27/016")!;
    expect(r.status).toBe("not_in_books");
    const m2 = gst({ books: GBOOKS.filter((b) => b.id !== "i16"), elsewhere: [{ ...GURUGRAM[0], key0: "INV/26-27/016", number: "INV/26-27/016" }] });
    expect(m2.rows.find((x) => x.filed?.number === "INV/26-27/016")!.hint!.text).toContain("Issued from Gurugram");
  });

  it("G-4 per head: ₹1.00 off matches, ₹1.01 is a value mismatch with the exact difference", () => {
    const j = gstr1OctoberJson();
    const inv = j.b2b[0].inv[0];
    inv.itms[0].itm_det.txval = 100001; inv.val = 118001;
    expect(statusOf(gst({ filed: filedOf(j) }), "INV/26-27/0016").status).toBe("matched_note");
    inv.itms[0].itm_det.txval = 100001.01; inv.val = 118000;
    const r = statusOf(gst({ filed: filedOf(j) }), "INV/26-27/0016");
    expect(r.status).toBe("value_mismatch");
    expect(r.issues.find((i) => i.code === "value_mismatch")!.differencePaise).toBe(101);
  });

  it("G-5 wrong recipient, including an invoice without a buyer GSTIN filed as B2B", () => {
    const books = GBOOKS.map((b) => (b.id === "i18" ? { ...b, buyerGstin: null, section: "b2cs" } : b));
    const r = statusOf(gst({ books }), "INV/26-27/0018");
    expect(r.status).toBe("wrong_recipient");
    expect(r.issues.find((i) => i.code === "wrong_recipient")!.message).toBe("Filed as B2B, the invoice has no buyer GSTIN.");
  });

  it("G-6 wrong period both ways, and the not-uploaded sentence", () => {
    const m = gst({ otherPeriods: [{ period: "2026-11", label: "November 2026", section: "b2b", numberKey: "INV/26-27/19" }] });
    const r = statusOf(m, "INV/26-27/0019");
    expect(r.status).toBe("wrong_period");
    expect(r.hint!.text).toBe("Filed in November 2026's GSTR-1.");
    expect(statusOf(gst({ nextPeriod: { label: "November 2026", uploaded: true } }), "INV/26-27/0019").issues[0].message).toContain("report it in the next GSTR-1");
  });

  it("G-7 cancelled and not filed → no row, counted", () => {
    const j = gstr1OctoberJson();
    j.b2b[2].inv = [];
    const m = gst({ filed: filedOf(j) });
    expect(m.rows.some((r) => r.books?.number === "INV/26-27/0022")).toBe(false);
    expect(m.counts.cancelledNotFiled).toBe(1);
  });

  it("G-8 / G-9 filed twice; a filed debit note", () => {
    const j = gstr1OctoberJson();
    j.b2b[0].inv.push({ ...j.b2b[0].inv[1] });
    (j.cdnr[0].nt as Array<Record<string, unknown>>).push({ ntty: "D", nt_num: "DN/1", nt_dt: "30-10-2026", val: 100, itms: [] });
    const m = gst({ filed: filedOf(j) });
    const twice = m.rows.filter((r) => r.filed?.number === "INV/26-27/0018");
    expect(twice.map((r) => r.status).sort()).toEqual(["not_in_books", "value_mismatch"]);
    expect(twice.find((r) => r.status === "not_in_books")!.issues[0].message).toBe("Filed twice — same number as b2b[0].inv[1].");
    expect(m.rows.find((r) => r.filed?.number === "DN/1")).toMatchObject({ status: "not_in_books", issues: [{ code: "debit_note" }] });
  });

  it("G-10 hints: other registration, other company, proforma, none", () => {
    const base = { number: "X", invoiceId: "z", companyKey: "dmpl", gstin: null, label: "Dashmani Media" };
    const hint = (kind: "registration" | "company" | "proforma") => gst({ elsewhere: [{ ...base, kind, key0: "DSPL/26-27/0155", gstin: kind === "registration" ? "06AAKCD3352K1ZJ" : null, label: kind === "registration" ? "Gurugram" : "Dashmani Media" }] });
    expect(statusOf(hint("company"), "DSPL/26-27/0155").hint).toMatchObject({ text: "Issued by Dashmani Media.", companyKey: "dmpl" });
    expect(statusOf(hint("proforma"), "DSPL/26-27/0155").hint!.text).toBe("A proforma — proformas are not filed.");
    expect(statusOf(hint("registration"), "DSPL/26-27/0155").hint!.text).toContain("Gurugram");
    expect(statusOf(gst(), "DSPL/26-27/0155").hint!.importable).toBe(true);
  });

  it("G-11 shuffled inputs → deep-equal output", () => {
    const a = gst();
    const b = gst({ books: [...GBOOKS].reverse(), filed: [...filedOf(gstr1OctoberJson())].reverse() });
    expect(b).toEqual(a);
  });

  it("G-12 pass 3 (number_differs), SEZ vs filed type, section totals", () => {
    const j = gstr1OctoberJson();
    j.b2b[1].inv[0].inum = "SW-17";
    j.b2b[1].ctin = KANARA;
    const r = statusOf(gst({ filed: filedOf(j) }), "INV/26-27/0017");
    expect(r.status).toBe("value_mismatch");
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["number_differs"]));
    const sez = GBOOKS.map((b) => (b.id === "i17" ? { ...b, section: "sez" } : b));
    const j2 = gstr1OctoberJson();
    j2.b2b[1].ctin = KANARA;
    (j2.b2b[1].inv[0] as Record<string, unknown>).inv_typ = "SEWOP";
    expect(statusOf(gst({ books: sez, filed: filedOf(j2) }), "INV/26-27/0017").status).toBe("matched");
    (j2.b2b[1].inv[0] as Record<string, unknown>).inv_typ = "R";
    expect(statusOf(gst({ books: sez, filed: filedOf(j2) }), "INV/26-27/0017").issues.map((i) => i.code)).toContain("type_differs");
    const m = gst({ filedOther: { b2cs: { docs: 1, valuePaise: R(1000), taxablePaise: R(900), igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 } } });
    const b2cs = m.sections.find((s) => s.section === "b2cs")!;
    expect(b2cs).toMatchObject({ comparedItemwise: false, differs: true });
    expect(m.sections.find((s) => s.section === "b2b")!.books.taxablePaise).toBe(R(100000 + 200000 + 50000 + 30000));
  });

  it("G-13 taxColumns false → no tax-head differences; value, taxable, rate still compared", () => {
    const filed = filedOf(gstr1OctoberJson()).map((f) => ({ ...f, igstPaise: null, cgstPaise: null, sgstPaise: null }));
    const m = gst({ filed });
    expect(statusOf(m, "INV/26-27/0016").status).toBe("matched_note");
    expect(statusOf(m, "INV/26-27/0018").issues.filter((i) => i.code === "value_mismatch").map((i) => i.message.split(":")[0])).toEqual(["Taxable", "Value"]);
  });
});

// ─── Ledger (§5.3) ───────────────────────────────────────────────────────────────────────────
function statement(): LedgerStatement {
  return {
    client: { id: "c1", companyName: "Filmy Brands", billingProfile: { legalName: "Filmy Brands Private Limited", gstin: FILMY, pan: null, addressLine1: "1 Road", addressLine2: null, city: "Mumbai", state: null, pincode: "400001", tan: "MUMF12345A" } },
    invoices: [
      { id: "i161", number: "INV/25-26/0161", kind: "tax_invoice", status: "paid", issueDate: "2026-03-20", totalPaise: R(23600) },
      { id: "i10", number: "INV/26-27/0010", kind: "tax_invoice", status: "paid", issueDate: "2026-09-20", totalPaise: R(118000) },
      { id: "i16", number: "INV/26-27/0016", kind: "tax_invoice", status: "issued", issueDate: "2026-10-14", totalPaise: R(118000) },
    ],
    payments: [
      { id: "p2", number: "RCPT/26-27/0002", status: "recorded", paidOn: "2026-04-10", amountPaise: R(23600), tdsPaise: 0, mode: "bank_transfer", reference: null, allocations: [{ invoiceId: "i161", amountPaise: R(23600), tdsPaise: 0 }], refunds: [] },
      { id: "p40", number: "RCPT/26-27/0040", status: "recorded", paidOn: "2026-10-03", amountPaise: R(108000), tdsPaise: R(10000), mode: "bank_transfer", reference: "UTR1", allocations: [{ invoiceId: "i10", amountPaise: R(108000), tdsPaise: R(10000) }], refunds: [] },
      { id: "p49", number: "RCPT/26-27/0049", status: "recorded", paidOn: "2026-10-31", amountPaise: R(50000), tdsPaise: 0, mode: "upi", reference: null, allocations: [], refunds: [] },
    ],
    creditNotes: [{ id: "cn4", number: "CN/26-27/0004", status: "issued", issueDate: new Date("2026-10-30T00:00:00Z"), totalPaise: R(11800), invoiceId: "i16" }],
    totals: { outstandingPaise: R(106200), unappliedPaise: R(50000) },
  };
}
const EXTRA = { company: "dspl", seller: { legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLines: [], email: null }, today: "2026-10-31", generatedAt: "2026-10-31T10:00:00.000Z", cancelInfo: {} };

describe("client ledger", () => {
  it("L-1 the §5.3 example: opening, running balances, closing ₹56,200.00 Dr", () => {
    const l = buildLedger(statement(), { from: "2026-04-01", to: "2026-10-31" }, EXTRA);
    expect(l.openingPaise).toBe(R(23600));
    expect(l.lines.map((x) => [x.day, x.kind, x.debitPaise, x.creditPaise, x.balancePaise])).toEqual([
      ["2026-04-10", "receipt", 0, R(23600), 0],
      ["2026-09-20", "invoice", R(118000), 0, R(118000)],
      ["2026-10-03", "receipt", 0, R(108000), R(10000)],
      ["2026-10-03", "tds", 0, R(10000), 0],
      ["2026-10-14", "invoice", R(118000), 0, R(118000)],
      ["2026-10-30", "credit_note", 0, R(11800), R(106200)],
      ["2026-10-31", "receipt", 0, R(50000), R(56200)],
    ]);
    expect(l.closingPaise).toBe(R(56200));
    expect(l.side).toBe("Dr");
    expect(l.lines[5].particulars).toBe("Credit note CN/26-27/0004 against INV/26-27/0016");
    expect(l.lines[6].particulars).toContain("(advance)");
    expect(l.client.tans).toEqual(["MUMF12345A"]);
  });

  it("L-2 excluded documents footnoted; same-day order invoice → refund → credit note → receipt → TDS", () => {
    const st = statement();
    st.invoices.push({ id: "ix", number: "INV/26-27/0020", kind: "tax_invoice", status: "cancelled", issueDate: "2026-10-05", totalPaise: R(500) });
    st.invoices.push({ id: "pf", number: "PI/26-27/0001", kind: "proforma", status: "issued", issueDate: "2026-10-05", totalPaise: R(700) });
    st.payments.push({ id: "pv", number: "RCPT/26-27/0045", status: "voided", paidOn: "2026-10-05", amountPaise: R(100), tdsPaise: 0, mode: "cash", reference: null, allocations: [], refunds: [] });
    st.payments[2].refunds.push({ id: "rf1", number: "RF/26-27/0001", status: "issued", refundedOn: "2026-10-31", amountPaise: R(1000) }, { id: "rf2", number: "RF/26-27/0002", status: "cancelled", refundedOn: "2026-10-31", amountPaise: R(200) });
    st.creditNotes.push({ id: "cnx", number: "CN/26-27/0009", status: "cancelled", issueDate: "2026-10-31", totalPaise: R(300), invoiceId: "i16" });
    st.invoices.push({ id: "i31", number: "INV/26-27/0031", kind: "tax_invoice", status: "issued", issueDate: "2026-10-31", totalPaise: R(10) });
    const l = buildLedger(st, { from: "2026-04-01", to: "2026-10-31" }, { ...EXTRA, today: "2026-11-01", cancelInfo: { ix: { day: "2026-10-06", reason: "wrong client" }, pv: { day: "2026-10-07", reason: "bounced" } } });
    expect(l.excluded.map((x) => [x.kind, x.number, x.changedOn, x.reason])).toEqual([
      ["cancelled_invoice", "INV/26-27/0020", "2026-10-06", "wrong client"],
      ["voided_receipt", "RCPT/26-27/0045", "2026-10-07", "bounced"],
      ["cancelled_credit_note", "CN/26-27/0009", null, null],
      ["cancelled_refund", "RF/26-27/0002", null, null],
    ]);
    expect(l.lines.some((x) => x.number.startsWith("PI/"))).toBe(false);
    expect(l.lines.filter((x) => x.day === "2026-10-31").map((x) => x.kind)).toEqual(["invoice", "refund", "receipt"]);
  });

  it("L-3 a receipt allocated to a proforma → the advance note", () => {
    const st = statement();
    st.invoices.push({ id: "pf", number: "PI/26-27/0003", kind: "proforma", status: "issued", issueDate: "2026-10-20", totalPaise: R(5000) });
    st.payments.push({ id: "pp", number: "RCPT/26-27/0050", status: "recorded", paidOn: "2026-10-21", amountPaise: R(5000), tdsPaise: 0, mode: "upi", reference: null, allocations: [{ invoiceId: "pf", amountPaise: R(5000), tdsPaise: 0 }], refunds: [] });
    const l = buildLedger(st, { from: "2026-04-01", to: "2026-10-31" }, EXTRA);
    expect(l.notes).toContain("₹5,000.00 received against proforma PI/26-27/0003 is shown as an advance until its tax invoice is issued.");
    expect(l.lines.find((x) => x.docId === "pp")!.particulars).toContain("against proforma PI/26-27/0003");
  });

  it("L-4 identity: closing = outstanding − unapplied − proforma allocations (with a proforma and a refund)", () => {
    const st = statement();
    st.invoices.push({ id: "pf", number: "PI/26-27/0003", kind: "proforma", status: "issued", issueDate: "2026-10-20", totalPaise: R(5000) });
    st.payments.push({ id: "pp", number: "RCPT/26-27/0050", status: "recorded", paidOn: "2026-10-21", amountPaise: R(5000), tdsPaise: 0, mode: "upi", reference: null, allocations: [{ invoiceId: "pf", amountPaise: R(5000), tdsPaise: 0 }], refunds: [] });
    st.payments[2].refunds.push({ id: "rf1", number: "RF/26-27/0001", status: "issued", refundedOn: "2026-10-31", amountPaise: R(1000) });
    st.totals.unappliedPaise = R(49000);
    const l = buildLedger(st, { from: "2026-04-01", to: "2026-10-31" }, EXTRA);
    expect(l.closingPaise).toBe(R(106200 - 49000 - 5000));
    expect(l.checks.identityOk).toBe(true);
    const past = buildLedger(st, { from: "2026-04-01", to: "2026-09-30" }, EXTRA);
    expect(past.checks.identityOk).toBeNull();
  });
});
