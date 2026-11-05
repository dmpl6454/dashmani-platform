/**
 * Bank matcher (spec-bank §4.3–4.4, tests §8.2) — pure: no DB. Every money figure is checked to
 * the paisa. Red-green cases are marked (R→G) and were each proven by breaking the rule once.
 */
import { describe, it, expect } from "vitest";
import { MAX_PAISE, sectionForRate, splitTds } from "@dashmani/shared";
import { classifyPastTds, fingerprintTokens, ignoreHintFor, matchCredits, matchDebits, prepareNarration, type ClientInfo, type MatchContext, type MatchLine, type OpenInvoice, type UnlinkedReceipt } from "../src/services/sales/bank-match";

const OWN = ["Digital Sukoon Private Limited", "Dashmani Media Private Limited"];
const FILMY: ClientInfo = { id: "c-filmy", names: ["Filmy Brands", "Filmy Brands Private Limited"], gstin: "27AABCU9603R1ZX", pan: "AABCU9603R", pastTds: null };
const OTHER: ClientInfo = { id: "c-other", names: ["Zenith Retail"], gstin: null, pan: null, pastTds: null };
const NEFT = "NEFT CR-HDFC0000240-FILMY BRANDS PVT LTD-DIGITAL SUKOON PRIVATE LIMITED-HDFCN52026110512";

function inv(over: Partial<OpenInvoice> & { id: string }): OpenInvoice {
  const base: OpenInvoice = {
    id: over.id, number: "INV/26-27/0016", kind: "tax_invoice", clientId: FILMY.id, issueDate: "2026-10-20", dueDate: "2026-11-04",
    totalPaise: 11_800_000, taxablePaise: 10_000_000, creditedPaise: 0, creditedTaxablePaise: 0, tdsSoFarPaise: 0, balancePaise: 11_800_000,
  };
  return { ...base, ...over };
}
function line(over: Partial<MatchLine> & { id: string; creditPaise: number }): MatchLine {
  return { txnDate: "2026-11-05", remainingPaise: over.creditPaise, narration: NEFT, reference: null, utr: null, possibleDuplicate: false, rowNo: 1, ...over };
}
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({ ownNames: OWN, invoices: [inv({ id: "i16" })], clients: [FILMY, OTHER], receipts: [], fingerprints: [], ...over });
const top = (r: ReturnType<typeof matchCredits>, id: string) => r[id].candidates[0];

describe("worked example (§4.4)", () => {
  const cases: Array<{ credit: number; code: string; tds: number; score: number; conf: string; rate?: number | null }> = [
    { credit: 11_800_000, code: "A_EXACT", tds: 0, score: 80, conf: "high", rate: null },
    { credit: 11_600_000, code: "A_TDS", tds: 200_000, score: 75, conf: "high", rate: 200 },
    { credit: 10_800_000, code: "A_TDS", tds: 1_000_000, score: 75, conf: "high", rate: 1000 },
    { credit: 10_800_040, code: "A_TDS", tds: 999_960, score: 75, conf: "high", rate: 1000 },
    { credit: 10_620_000, code: "A_TDS_GROSS", tds: 1_180_000, score: 60, conf: "medium", rate: 1000 },
    { credit: 11_700_000, code: "A_TDS", tds: 100_000, score: 75, conf: "high", rate: 100 },
  ];
  for (const c of cases) {
    it(`₹${c.credit / 100} → ${c.code}, TDS ${c.tds / 100}`, () => {
      const r = matchCredits([line({ id: "L", creditPaise: c.credit })], ctx());
      const t = top(r, "L");
      expect(t.codes[0]).toBe(c.code);
      expect(t.codes).toContain("I_NAME");
      expect(t.amountPaise).toBe(c.credit);
      expect(t.tdsPaise).toBe(c.tds);
      expect(t.allocations).toEqual([expect.objectContaining({ invoiceId: "i16", amountPaise: c.credit, tdsPaise: c.tds })]);
      expect(t.score).toBe(c.score);
      expect(t.confidence).toBe(c.conf);
      expect(t.tdsRateBp).toBe(c.rate ?? null);
      expect(r.L.bestScore).toBe(c.score);
    });
  }

  it("10% fit carries 194J; 1% carries the company-payee hint; gross cites the circular", () => {
    expect(top(matchCredits([line({ id: "L", creditPaise: 10_800_000 })], ctx()), "L").tdsSection).toBe("194J");
    const one = top(matchCredits([line({ id: "L", creditPaise: 11_700_000 })], ctx()), "L");
    expect(one.tdsSection).toBe("194C");
    expect(one.reasons.join(" ")).toContain("company payee should suffer 2%");
    expect(top(matchCredits([line({ id: "L", creditPaise: 10_620_000 })], ctx()), "L").reasons.join(" ")).toContain("CBDT circular 23/2017");
  });

  it("₹1,08,000.40: the tolerance identifies the rate, the TDS is the exact shortfall (R→G)", () => {
    const t = top(matchCredits([line({ id: "L", creditPaise: 10_800_040 })], ctx()), "L");
    expect(t.tdsPaise + t.amountPaise).toBe(11_800_000);
    expect(t.tdsPaise).toBe(999_960);
  });

  it("a UPI credit with no name is likely; after a confirm its VPA fingerprint makes it sure", () => {
    const upi = "UPI/CR/530912345678/RIYA SHARMA/YESB/riya@ybl/Payment";
    const before = top(matchCredits([line({ id: "L", creditPaise: 11_600_000, narration: upi })], ctx()), "L");
    expect([before.score, before.confidence]).toEqual([45, "medium"]);
    expect(fingerprintTokens(upi, "530912345678")).toEqual(["riya@ybl"]);
    const after = top(matchCredits([line({ id: "L", creditPaise: 11_600_000, narration: upi })], ctx({ fingerprints: [{ token: "riya@ybl", clientId: FILMY.id }] })), "L");
    expect(after.codes).toContain("I_FP");
    expect([after.score, after.confidence]).toEqual([80, "high"]);
  });

  it("pair with 2% TDS: both invoices close exactly", () => {
    const i19 = inv({ id: "i19", number: "INV/26-27/0019", taxablePaise: 5_000_000, totalPaise: 5_900_000, balancePaise: 5_900_000, dueDate: "2026-11-10" });
    const t = top(matchCredits([line({ id: "L", creditPaise: 17_400_000 })], ctx({ invoices: [inv({ id: "i16" }), i19] })), "L");
    expect(t.codes[0]).toBe("A_PAIR_TDS");
    expect(t.allocations.map((a) => [a.invoiceId, a.amountPaise, a.tdsPaise])).toEqual([["i16", 11_600_000, 200_000], ["i19", 5_800_000, 100_000]]);
    expect([t.score, t.confidence]).toEqual([65, "medium"]);
  });

  it("pair exact (59,000 + 59,000)", () => {
    const a = inv({ id: "a", number: "INV/26-27/0020", taxablePaise: 5_000_000, totalPaise: 5_900_000, balancePaise: 5_900_000 });
    const b = inv({ id: "b", number: "INV/26-27/0021", taxablePaise: 5_000_000, totalPaise: 5_900_000, balancePaise: 5_900_000, dueDate: "2026-11-20" });
    const r = matchCredits([line({ id: "L", creditPaise: 11_800_000 })], ctx({ invoices: [a, b] }));
    const pair = r.L.candidates.find((c) => c.codes[0] === "A_PAIR")!;
    expect(pair.allocations.map((x) => x.amountPaise)).toEqual([5_900_000, 5_900_000]);
  });

  it("rupee-rounded 1%: ₹14,445 against ₹14,568 → TDS ₹123.00", () => {
    const i = inv({ id: "ir", taxablePaise: 1_234_567, totalPaise: 1_456_800, balancePaise: 1_456_800 });
    const t = top(matchCredits([line({ id: "L", creditPaise: 1_444_500 })], ctx({ invoices: [i] })), "L");
    expect([t.codes[0], t.tdsPaise, t.tdsRateBp]).toEqual(["A_TDS", 12_300, 100]);
  });
});

describe("TDS rules", () => {
  it("gross TDS scores below taxable and is never sure; taxable ranks first when both fit different invoices", () => {
    const a = inv({ id: "a" }); // 10% taxable at 10,800,000
    const b = inv({ id: "b", number: "INV/26-27/0030", taxablePaise: 10_169_492, totalPaise: 12_000_000, balancePaise: 12_000_000, dueDate: "2026-10-01" }); // 10% gross: 12,000,000 − 1,200,000
    const r = matchCredits([line({ id: "L", creditPaise: 10_800_000 })], ctx({ invoices: [a, b] }));
    expect(r.L.candidates.map((c) => c.codes[0])).toEqual(["A_TDS", "A_TDS_GROSS"]);
    expect(r.L.candidates[1].confidence).not.toBe("high");
  });

  it("past rate first: history 10% on taxable ranks the 10% invoice over a 2% one (R→G); a custom 0.75% fits", () => {
    const x = inv({ id: "x", dueDate: "2026-11-30" });
    const y = inv({ id: "y", number: "INV/26-27/0040", taxablePaise: 9_310_345, totalPaise: 10_986_207, balancePaise: 10_986_207, dueDate: "2026-10-01" });
    const own = { ...FILMY, pastTds: { rateBp: 1000, base: "taxable" as const, receiptNumber: "RCPT/26-27/0031" } };
    const r = matchCredits([line({ id: "L", creditPaise: 10_800_000 })], ctx({ invoices: [x, y], clients: [own, OTHER] }));
    expect(r.L.candidates[0].allocations[0].invoiceId).toBe("x");
    expect(r.L.candidates[0].codes[0]).toBe("A_TDS_OWN");
    expect(r.L.candidates[0].reasons.join(" ")).toContain("RCPT/26-27/0031");
    // Without the history the earlier-due 2% invoice would lead.
    expect(matchCredits([line({ id: "L", creditPaise: 10_800_000 })], ctx({ invoices: [x, y] })).L.candidates[0].allocations[0].invoiceId).toBe("y");
    const custom = { ...FILMY, pastTds: { rateBp: 75, base: "taxable" as const, receiptNumber: "RCPT/26-27/0001" } };
    const c = top(matchCredits([line({ id: "L", creditPaise: 11_725_000 })], ctx({ clients: [custom, OTHER] })), "L");
    expect([c.codes[0], c.tdsPaise, c.tdsRateBp]).toEqual(["A_TDS_OWN", 75_000, 75]);
  });

  it("the TDS base nets credit notes; the pro-rata variant fits a part-paid invoice", () => {
    const credited = inv({ id: "cn", creditedTaxablePaise: 2_000_000, creditedPaise: 2_360_000, balancePaise: 9_440_000 });
    expect(top(matchCredits([line({ id: "L", creditPaise: 8_640_000 })], ctx({ invoices: [credited] })), "L").tdsPaise).toBe(800_000);
    const part = inv({ id: "pp", balancePaise: 5_900_000 });
    const t = top(matchCredits([line({ id: "L", creditPaise: 5_400_000 })], ctx({ invoices: [part] })), "L");
    expect([t.codes[0], t.tdsPaise]).toEqual(["A_TDS", 500_000]);
  });
});

describe("confidence and assignment", () => {
  it("an exact amount fitting two clients' invoices with no identity → both at most likely (R→G)", () => {
    const zen = inv({ id: "z", number: "INV/26-27/0050", clientId: OTHER.id });
    const r = matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: "NEFT CR 0000 SOMEONE" })], ctx({ invoices: [inv({ id: "i16" }), zen] }));
    expect(r.L.candidates).toHaveLength(2);
    for (const c of r.L.candidates) expect(c.confidence).not.toBe("high");
    // Even with both clients named (80 each), a rival within 15 points of another client keeps both likely.
    const zen2 = { ...OTHER, names: ["Zenith Retail"] };
    const both = matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: "NEFT FILMY BRANDS ZENITH RETAIL" })], ctx({ invoices: [inv({ id: "i16" }), zen], clients: [FILMY, zen2] }));
    expect(both.L.candidates.map((c) => c.score)).toEqual([80, 80]);
    for (const c of both.L.candidates) expect(c.confidence).toBe("medium");
  });

  it("same client with two equal retainer invoices + name → sure on the oldest due", () => {
    const a = inv({ id: "a", number: "INV/26-27/0060", dueDate: "2026-11-30" });
    const b = inv({ id: "b", number: "INV/26-27/0061", dueDate: "2026-10-30" });
    const r = matchCredits([line({ id: "L", creditPaise: 11_800_000 })], ctx({ invoices: [a, b] }));
    expect(r.L.candidates[0].allocations[0].invoiceId).toBe("b");
    expect(r.L.candidates[0].confidence).toBe("high");
  });

  it("two credits competing for one invoice: the earlier claims it, the other gets the conflict and is never sure (R→G)", () => {
    const r = matchCredits(
      [line({ id: "L2", creditPaise: 11_800_000, txnDate: "2026-11-06", rowNo: 2 }), line({ id: "L1", creditPaise: 11_800_000, txnDate: "2026-11-05", rowNo: 1 })],
      ctx(),
    );
    expect(r.L1.conflict).toBeNull();
    expect(r.L1.confidence).toBe("high");
    expect(r.L2.conflict).toEqual({ lineId: "L1", txnDate: "2026-11-05", invoiceNumber: "INV/26-27/0016" });
    expect(r.L2.confidence).not.toBe("high");
  });

  it("a possible duplicate is never sure and never auto-linked", () => {
    const r = matchCredits([line({ id: "L", creditPaise: 11_800_000, possibleDuplicate: true })], ctx({ receipts: [rc({ id: "p", amountPaise: 11_800_000, paidOn: "2026-11-04" })] }));
    expect(r.L.autoLink).toBeNull();
    for (const c of r.L.candidates) expect(c.confidence).not.toBe("high");
  });

  it("a credit dated before the invoice was issued loses 20 and is never sure", () => {
    const t = top(matchCredits([line({ id: "L", creditPaise: 11_800_000, txnDate: "2026-10-01" })], ctx()), "L");
    expect(t.codes).toContain("J_BEFORE_ISSUE");
    expect(t.score).toBe(60);
    expect(t.confidence).toBe("medium");
  });

  it("advance: an identified client with no fit → A_ADVANCE, no allocations, at most likely; a weak name gives none", () => {
    const r = matchCredits([line({ id: "L", creditPaise: 5_000_000 })], ctx());
    const adv = r.L.candidates.find((c) => c.kind === "advance")!;
    expect(adv.allocations).toEqual([]);
    expect(adv.amountPaise).toBe(5_000_000);
    expect(adv.confidence).not.toBe("high");
    const weak = matchCredits([line({ id: "L", creditPaise: 5_000_000, narration: "IMPS 1234 FILMYB" })], ctx());
    expect(weak.L.candidates).toEqual([]);
  });

  it("over-payment with the invoice number in the narration → A_OVER, the rest an advance", () => {
    const t = matchCredits([line({ id: "L", creditPaise: 12_000_000, narration: "NEFT FILMY BRANDS INV/26-27/0016" })], ctx()).L.candidates.find((c) => c.codes[0] === "A_OVER")!;
    expect(t.allocations[0].amountPaise).toBe(11_800_000);
    expect(t.advancePaise).toBe(200_000);
  });

  it("the invoice number beats another same-amount invoice of the client; the short form gives the smaller bonus", () => {
    const a = inv({ id: "a", number: "INV/26-27/0015", dueDate: "2026-10-01" });
    const b = inv({ id: "b", number: "INV/26-27/0016", dueDate: "2026-11-30" });
    const full = matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: "NEFT FILMY BRANDS INV 26-27 0016" })], ctx({ invoices: [a, b] }));
    expect(full.L.candidates[0].allocations[0].invoiceId).toBe("b");
    expect(full.L.candidates[0].codes).toContain("I_INVNO");
    const short = matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: "NEFT FILMY BRANDS INV0016" })], ctx({ invoices: [a, b] }));
    expect(short.L.candidates[0].allocations[0].invoiceId).toBe("b");
    expect(short.L.candidates[0].codes).toContain("I_INVNO_SHORT");
  });

  it("a credit above MAX_PAISE gets no candidates, note too_large", () => {
    const r = matchCredits([line({ id: "L", creditPaise: MAX_PAISE + 100 })], ctx());
    expect(r.L.candidates).toEqual([]);
    expect(r.L.note).toBe("too_large");
  });
});

function rc(over: Partial<UnlinkedReceipt> & { id: string; amountPaise: number; paidOn: string }): UnlinkedReceipt {
  return { number: `RCPT/${over.id}`, clientId: FILMY.id, reference: null, mode: "bank_transfer", ...over };
}

describe("stage 1 — receipts already recorded (each R→G)", () => {
  const L = (over: Partial<MatchLine> = {}) => line({ id: "L", creditPaise: 11_600_000, ...over });
  it("unique same-amount receipt 2 days earlier → auto-link, no invoice candidates", () => {
    const r = matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-03" })] }));
    expect(r.L.autoLink).toEqual({ paymentId: "p", number: "RCPT/p", why: "same amount, 2 days apart" });
    expect(r.L.candidates).toEqual([]);
  });
  it("4 days apart → no link", () => {
    expect(matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-01" })] })).L.autoLink).toBeNull();
  });
  it("two receipts fit → no link, both offered", () => {
    const r = matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-04" }), rc({ id: "q", amountPaise: 11_600_000, paidOn: "2026-11-05" })] }));
    expect(r.L.autoLink).toBeNull();
    expect(r.L.receiptCandidates.map((x) => x.paymentId).sort()).toEqual(["p", "q"]);
    for (const c of r.L.candidates) expect(c.confidence).not.toBe("high");
  });
  it("same UTR links even with another same-amount receipt about", () => {
    const r = matchCredits([L({ utr: "HDFCN52026110512" })], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-10-01", reference: "HDFCN52026110512" }), rc({ id: "q", amountPaise: 11_600_000, paidOn: "2026-11-05" })] }));
    expect(r.L.autoLink).toMatchObject({ paymentId: "p", why: "same UTR HDFCN52026110512" });
  });
  it("a receipt of client A while the narration names client B → no link", () => {
    const r = matchCredits([L()], ctx({ receipts: [rc({ id: "p", clientId: OTHER.id, amountPaise: 11_600_000, paidOn: "2026-11-04" })] }));
    expect(r.L.autoLink).toBeNull();
  });
  it("₹0.40 off within 3 days → link (±₹1)", () => {
    expect(matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_599_960, paidOn: "2026-11-05" })] })).L.autoLink?.paymentId).toBe("p");
  });
  it("two identical credits and one receipt → only one line links", () => {
    const r = matchCredits([line({ id: "A", creditPaise: 11_600_000, rowNo: 1 }), line({ id: "B", creditPaise: 11_600_000, rowNo: 2 })], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-05" })] }));
    expect([r.A.autoLink, r.B.autoLink].filter(Boolean)).toHaveLength(1);
  });
  it("razorpay receipts are never considered; imported (Swipe) receipts are offered, never linked", () => {
    const rz = matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-05", mode: "razorpay" })] }));
    expect(rz.L.autoLink).toBeNull();
    expect(rz.L.receiptCandidates).toEqual([]);
    const imp = matchCredits([L()], ctx({ receipts: [rc({ id: "p", amountPaise: 11_600_000, paidOn: "2026-11-05", imported: true })] }));
    expect(imp.L.autoLink).toBeNull();
    expect(imp.L.receiptCandidates[0].why).toContain("Swipe import");
  });
});

describe("narration and identity", () => {
  it("our own names never identify a client (R→G); a client with no distinctive token never matches", () => {
    const sukoon: ClientInfo = { id: "c-sk", names: ["Sukoon Foods"], gstin: null, pan: null, pastTds: null };
    const i = inv({ id: "s", clientId: sukoon.id });
    const r = matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: "NEFT CR-ACME-DIGITAL SUKOON PRIVATE LIMITED-XYZ123" })], ctx({ invoices: [i], clients: [sukoon] }));
    expect(top(r, "L").codes).not.toContain("I_NAME");
    expect(top(r, "L").score).toBe(50);
    expect(prepareNarration("NEFT CR-ACME-DIGITAL SUKOON PRIVATE LIMITED", OWN)).toEqual(["ACME"]);
    const dm: ClientInfo = { id: "c-dm", names: ["Digital Media Co"], gstin: null, pan: null, pastTds: null };
    const r2 = matchCredits([line({ id: "L", creditPaise: 5_000_000, narration: "NEFT DIGITAL MEDIA CO" })], ctx({ invoices: [], clients: [dm] }));
    expect(r2.L.candidates).toEqual([]);
  });

  it("IMPS truncation FILMYBRA → I_NAME; FILMYB → I_NAME_PART; FILMYBRANDSPVTLTD → I_NAME; GSTIN → I_TAXID", () => {
    const code = (narr: string) => top(matchCredits([line({ id: "L", creditPaise: 11_800_000, narration: narr })], ctx()), "L").codes;
    expect(code("IMPS 1234 FILMYBRA")).toContain("I_NAME");
    expect(code("IMPS 1234 FILMYB")).toContain("I_NAME_PART");
    expect(code("NEFT FILMYBRANDSPVTLTD")).toContain("I_NAME");
    expect(code("NEFT 27AABCU9603R1ZX")).toContain("I_TAXID");
  });

  it("ignore hints: interest, Razorpay, the other group company", () => {
    expect(ignoreHintFor("INT PD 30-09-2026", [])?.reason).toBe("interest");
    expect(ignoreHintFor("RAZORPAY SOFTWARE PVT LTD SETTLEMENT", [])?.reason).toBe("gateway");
    expect(ignoreHintFor("NEFT DASHMANI MEDIA PRIVATE LIMITED", ["Dashmani Media Private Limited"])?.reason).toBe("own_transfer");
    expect(ignoreHintFor(NEFT, ["Dashmani Media Private Limited"])).toBeNull();
  });
});

describe("matchDebits", () => {
  it("flags a refund we issued and a cheque return of a matched credit", () => {
    const r = matchDebits(
      [{ id: "d1", txnDate: "2026-11-06", debitPaise: 50_000, narration: "NEFT DR FILMY" }, { id: "d2", txnDate: "2026-11-08", debitPaise: 11_600_000, narration: "CHQ RETURN 000123" }],
      { refunds: [{ id: "rf", number: "RF/26-27/0003", amountPaise: 50_000, refundedOn: "2026-11-05" }], matchedCredits: [{ lineId: "c1", txnDate: "2026-11-05", creditPaise: 11_600_000, receiptNumbers: ["RCPT/26-27/0042"] }] },
    );
    expect(r.d1.refund).toEqual({ id: "rf", number: "RF/26-27/0003" });
    expect(r.d2.reversalOf).toEqual({ lineId: "c1", txnDate: "2026-11-05", receiptNumbers: ["RCPT/26-27/0042"] });
  });
});

describe("determinism", () => {
  it("shuffled inputs give a deep-equal result", () => {
    const invoices = [inv({ id: "i16" }), inv({ id: "i19", number: "INV/26-27/0019", taxablePaise: 5_000_000, totalPaise: 5_900_000, balancePaise: 5_900_000 }), inv({ id: "z", number: "INV/26-27/0070", clientId: OTHER.id })];
    const lines = [line({ id: "a", creditPaise: 11_600_000 }), line({ id: "b", creditPaise: 17_400_000, rowNo: 2 }), line({ id: "c", creditPaise: 11_800_000, rowNo: 3, narration: "NEFT SOMEONE" })];
    const receipts = [rc({ id: "p", amountPaise: 11_800_000, paidOn: "2026-11-05" }), rc({ id: "q", amountPaise: 99, paidOn: "2026-11-05" })];
    const one = matchCredits(lines, ctx({ invoices, receipts }));
    const two = matchCredits([...lines].reverse(), ctx({ invoices: [...invoices].reverse(), receipts: [...receipts].reverse(), clients: [OTHER, FILMY] }));
    expect(two).toEqual(one);
  });
});

describe("shared helpers", () => {
  it("splitTds: largest remainder, Σ = Σbalance − cash, null when cash exceeds the balances", () => {
    const s = splitTds([{ id: "a", balancePaise: 11_800_000, basePaise: 10_000_000 }, { id: "b", balancePaise: 5_900_000, basePaise: 5_000_000 }], 17_400_000)!;
    expect(s).toEqual([{ id: "a", amountPaise: 11_600_000, tdsPaise: 200_000 }, { id: "b", amountPaise: 5_800_000, tdsPaise: 100_000 }]);
    const odd = splitTds([{ id: "a", balancePaise: 100, basePaise: 1 }, { id: "b", balancePaise: 100, basePaise: 1 }, { id: "c", balancePaise: 100, basePaise: 1 }], 299)!;
    expect(odd.reduce((x, y) => x + y.tdsPaise, 0)).toBe(1);
    expect(splitTds([{ id: "a", balancePaise: 100, basePaise: 1 }], 101)).toBeNull();
    expect(sectionForRate(200)).toBe("194C");
    expect(sectionForRate(1000)).toBe("194J");
  });
});

describe("receipt index (one call over the whole history)", () => {
  it("finds the same receipts as a full scan: amount within ±₹1, UTR inside a long reference, a near-UTR short receipt", () => {
    const noise = Array.from({ length: 300 }, (_, k) => rc({ id: `n${String(k).padStart(3, "0")}`, amountPaise: 1_000_000 + k * 1_000, paidOn: "2026-11-04", reference: `REF${k}XYZ${k}` }));
    const lines = [
      line({ id: "A", creditPaise: 1_150_000 }),
      line({ id: "B", creditPaise: 9_000_000, utr: "HDFCN52026119999" }),
    ];
    const receipts = [
      ...noise,
      rc({ id: "u1", amountPaise: 8_000_000, paidOn: "2026-10-01", reference: "PAID VIA NEFT HDFCN52026119999 THANKS" }),
    ];
    const r = matchCredits(lines, ctx({ receipts }));
    expect(r.A.autoLink?.paymentId).toBe("n150");
    expect(r.B.receiptCandidates.map((x) => x.paymentId)).toEqual(["u1"]);
    expect(r.B.receiptCandidates[0].why).toContain("same UTR, differs by");
  });
});

describe("classifyPastTds (a stored rate keeps its base)", () => {
  // Invoice: taxable ₹1,00,000, total ₹1,18,000.
  const base = { taxablePaise: 10_000_000, totalPaise: 11_800_000 };
  it("10% of the total incl. GST stored as 1000 bp is a GROSS-base practice, not taxable (R→G)", () => {
    expect(classifyPastTds({ ...base, tdsRateBp: 1000, amountPaise: 10_620_000, tdsPaise: 1_180_000 })).toEqual({ rateBp: 1000, base: "gross" });
  });
  it("10% of taxable stored as 1000 bp stays taxable; a stored rate that fits neither base falls back to inference", () => {
    expect(classifyPastTds({ ...base, tdsRateBp: 1000, amountPaise: 10_800_000, tdsPaise: 1_000_000 })).toEqual({ rateBp: 1000, base: "taxable" });
    expect(classifyPastTds({ ...base, tdsRateBp: 1000, amountPaise: 11_600_000, tdsPaise: 200_000 })).toEqual({ rateBp: 200, base: "taxable" });
  });
  it("no stored rate: inferred as before", () => {
    expect(classifyPastTds({ ...base, tdsRateBp: null, amountPaise: 10_620_000, tdsPaise: 1_180_000 })).toEqual({ rateBp: 1000, base: "gross" });
    expect(classifyPastTds({ ...base, tdsRateBp: null, amountPaise: 11_600_000, tdsPaise: 0 })).toBeNull();
  });
});
