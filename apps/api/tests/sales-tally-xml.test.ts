/**
 * Tally export — the pure core (spec-tally §8.1, X1–X15). No database: amounts, dates, escaping,
 * the golden files of the §4.8 worked example (copied verbatim from the spec), the balance
 * property over random documents, exact splits, Tally's replies, the URL guard, the settings
 * schema, the content hash, the planner table and party naming.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { computeTotals, GST_STATE_CODES, tallySettingsSchema } from "@dashmani/shared";
import { amt, esc, tallyDate, tallyStateName } from "../src/services/sales/tally/xml";
import { splitExact } from "../src/services/sales/tally/money";
import { parseCollection, parseImportResponse, TallyReadError } from "../src/services/sales/tally/xml-read";
import {
  assertBalanced, buildCreditNote, buildDoc, buildReceipt, buildRefund, buildSales, contentHash, renderVoucher, tdsLedgerName,
  type AnyDoc, type BuildCtx, type InvoiceDoc, type ReceiptDoc,
} from "../src/services/sales/tally/vouchers";
import { renderPartyLedger } from "../src/services/sales/tally/masters";
import { buildFiles, ledgerKey, planTally, proposeLedgerName, type LastGood } from "../src/services/sales/tally/plan";
import { assertTallyTarget } from "../src/services/sales/tally/push.service";
import { CLIENT, CLIENT_ID, CN, doc, INV, planInput, RCPT, RCPT_AFTER_CN, REFUND, SETTINGS } from "./tally-worked-example";

const FIX = path.join(__dirname, "fixtures/tally");
const fixture = (p: string) => fs.readFileSync(path.join(FIX, p), "utf8");
const ctx = (over: Partial<BuildCtx> = {}): BuildCtx => ({ settings: SETTINGS, defaultSac: "998365", partyLedger: () => "Filmy Brands Private Limited", ...over });
const ok = (b: ReturnType<typeof buildDoc>) => { if (!b.ok) throw new Error(`${b.code}: ${b.message}`); return b.v; };

describe("X1–X3 encoding", () => {
  it("X1 amt: integer paise only, no float, no -0.00", () => {
    expect(amt(11_800_000)).toBe("118000.00");
    expect(amt(-5)).toBe("-0.05");
    expect(amt(-100)).toBe("-1.00");
    expect(amt(0)).toBe("0.00");
    expect(amt(2_147_483_647)).toBe("21474836.47");
    expect(amt(5_310_000_000)).toBe("53100000.00");
    expect(() => amt(1.5)).toThrow();
  });
  it("X2 tallyDate", () => {
    expect(tallyDate("2026-11-05")).toBe("20261105");
    expect(() => tallyDate("2026-02-30")).toThrow();
    expect(() => tallyDate("5 Nov 2026")).toThrow();
  });
  it("X3 esc: escapes, numeric references above 0x7E, control characters dropped, pure ASCII", () => {
    expect(esc(`A & B <Co> "x" 'y'`)).toBe("A &amp; B &lt;Co&gt; &quot;x&quot; &apos;y&apos;");
    expect(esc("Café ₹")).toBe("Caf&#233; &#8377;");
    expect(esc("a\u0007b")).toBe("ab");
    expect(esc("line one\nline two")).toBe("line one | line two");
    expect(esc("😀 Ünïcode\u0000\u001f")).toMatch(/^[\x09\x0A\x0D\x20-\x7E]*$/);
  });
});

describe("X4 golden files (the §4.8 worked example, copied verbatim from the spec)", () => {
  it("export #1 — masters and vouchers byte for byte", () => {
    const plan = planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV }), doc({ docType: "receipt", doc: RCPT })] }));
    expect(plan.runRows.map((r) => `${r.number}:${r.action}`)).toEqual(["INV/26-27/0016:create", "RCPT/26-27/0021:create"]);
    const files = buildFiles(plan, "Digital Sukoon Private Limited", "prime3");
    expect(files.masters).toBe(fixture("prime3/export1-masters.xml"));
    expect(files.vouchers).toBe(fixture("prime3/export1-vouchers.xml"));
    expect(plan.controlTotalPaise).toBe(23_600_000);
  });

  it("export #2 — the credit note is created, the receipt altered, the invoice NOT re-sent", () => {
    const one = planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV }), doc({ docType: "receipt", doc: RCPT })] }));
    const lastGood = new Map<string, LastGood>(one.runRows.map((r) => [r.docId, { action: r.action, contentHash: r.hash, partyAmountPaise: r.partyAmountPaise, runNo: 1, at: "2026-12-02T10:00:00.000Z", runId: "run1" }]));
    const plan = planTally(planInput({
      from: "2026-12-01", to: "2026-12-31", effectiveFrom: "2026-12-01", today: "2027-01-03", lastGood,
      mappings: [{ clientId: CLIENT_ID, ledgerName: "Filmy Brands Private Limited", ledgerKey: "filmy brands private limited", gstin: CLIENT.gstin, existsInTally: false, lockedAt: "2026-12-02T10:00:00.000Z" }],
      docs: [doc({ docType: "credit_note", doc: CN }), doc({ docType: "invoice", doc: { ...INV, status: "paid" } }, "earlier"), doc({ docType: "receipt", doc: RCPT_AFTER_CN }, "earlier")],
    }));
    expect(plan.runRows.map((r) => `${r.number}:${r.action}:${r.reason}`)).toEqual(["CN/26-27/0001:create:new", "RCPT/26-27/0021:alter:earlier_change"]);
    const files = buildFiles(plan, "Digital Sukoon Private Limited", "prime3");
    expect(files.masters).toBeNull();
    expect(files.vouchers).toBe(fixture("prime3/export2-vouchers.xml"));
    expect(plan.controlTotalPaise).toBe(12_980_000);
    expect(plan.issues.map((i) => i.code)).toContain("EARLIER_CHANGES");
    expect(plan.issues.map((i) => i.code)).toContain("ADVANCE_RECEIVED");
  });

  it("legacy party master and the cancel / cancelled-create forms", () => {
    const party = { name: "Filmy Brands Private Limited", group: "Sundry Debtors", mailingName: CLIENT.legalName!, gstin: CLIENT.gstin, pan: CLIENT.pan, addressLine1: "Bandra", addressLine2: null, city: "Mumbai", pincode: "400050", stateCode: "27", country: "IN" };
    expect(renderPartyLedger(party, "legacy")).toBe(fixture("legacy/party.xml"));
    const cancelled = ok(buildSales({ ...INV, id: "11111111-2222-4333-8444-555555555555", number: "INV/26-27/0017", issueDate: "2026-11-06", status: "cancelled", cancelledDay: "2026-11-07", cancelReason: "wrong client selected" }, ctx()));
    const text = renderVoucher(cancelled, "Cancel", "prime3") + renderVoucher(cancelled, "Create", "prime3");
    expect(text).toBe(fixture("prime3/cancel.xml"));
    expect(text).toContain('<VOUCHER DATE="20261106" TAGNAME="Voucher Number" TAGVALUE="INV/26-27/0017" VCHTYPE="Sales" ACTION="Cancel">');
    expect(text).toContain("<ISCANCELLED>Yes</ISCANCELLED>");
    expect(text).not.toContain("LEDGERENTRIES");
  });

  it("R/G: a changed template no longer matches the golden file", () => {
    const plan = planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV })] }));
    const broken = buildFiles(plan, "Digital Sukoon Private Limited", "prime3").vouchers.replace("<ISINVOICE>Yes</ISINVOICE>", "<ISINVOICE>No</ISINVOICE>");
    expect(fixture("prime3/export1-vouchers.xml").includes(broken.slice(broken.indexOf("<TALLYMESSAGE"), broken.indexOf("</TALLYMESSAGE>")))).toBe(false);
  });
});

// ── X5: balance over random documents ────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const RATES = [0, 500, 1200, 1800, 2800];
const SACS = ["998365", "998361", "998397"];
const multiSettings = tallySettingsSchema.parse({
  ...SETTINGS,
  salesLedgers: RATES.flatMap((r) => SACS.map((sac) => ({ name: `Sales ${sac} ${r / 100}%`, sac, gstRateBp: r }))),
  ledgers: { ...SETTINGS.ledgers, gateway: "Razorpay Clearing", other: "Other Receipts", zeroRatedSales: "Export Sales" },
});

function randomDocs(n: number, seed: number): AnyDoc[] {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const out: AnyDoc[] = [];
  for (let k = 0; k < n; k++) {
    const kind = int(0, 3);
    const lines = Array.from({ length: int(1, 6) }, () => ({ quantity: int(1, 5), unitPricePaise: int(1, 50_000_00), discountPaise: r() < 0.3 ? int(0, 10_000) : 0, sac: SACS[int(0, 2)] }));
    const rate = RATES[int(0, 4)];
    const taxMode = rate === 0 ? "none" : r() < 0.5 ? "intra" : "inter";
    const t = computeTotals({ lines, discountPaise: r() < 0.3 ? int(0, 5_000_00) : 0, taxMode: taxMode as "intra" | "inter" | "none", gstRateBp: rate, roundToRupee: r() < 0.7 });
    const inv: InvoiceDoc = {
      ...INV, id: `inv-${k}`, number: `INV/26-27/${k}`, taxMode, gstRateBp: rate, ...t,
      items: lines.map((l) => ({ description: "x", sac: l.sac, amountPaise: Math.max(0, l.quantity * l.unitPricePaise - l.discountPaise) })),
    };
    if (kind === 0) out.push({ docType: "invoice", doc: inv });
    else if (kind === 1) {
      const taxable = int(0, t.taxablePaise);
      const half = Math.round((taxable * rate) / 20_000);
      const tax = taxMode === "intra" ? { cgstPaise: half, sgstPaise: half, igstPaise: 0 } : taxMode === "inter" ? { cgstPaise: 0, sgstPaise: 0, igstPaise: half * 2 } : { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
      out.push({ docType: "credit_note", doc: { ...CN, id: `cn-${k}`, invoice: inv, taxablePaise: taxable, ...tax, totalPaise: taxable + tax.cgstPaise + tax.sgstPaise + tax.igstPaise + int(-50, 50) } });
    } else if (kind === 2) {
      const amount = int(0, 1) ? int(1, 20_000_000) : 0;
      const tds = int(0, 1) || amount === 0 ? int(1, 2_000_000) : 0;
      let left = amount + tds;
      const allocations = Array.from({ length: int(0, 3) }, (_, j) => {
        const a = Math.min(left, int(0, left));
        left -= a;
        return { invoiceId: `x${j}`, amountPaise: a, tdsPaise: 0, createdAt: "2026-11-01T00:00:00Z", invoiceNumber: `INV/X/${j}`, invoiceKind: r() < 0.7 ? "tax_invoice" : "proforma", invoiceStatus: "issued", invoiceDate: "2026-11-01", invoiceGstin: INV.seller.gstin ?? null };
      });
      out.push({ docType: "receipt", doc: { ...RCPT, id: `rc-${k}`, amountPaise: amount, tdsPaise: tds, mode: ["bank_transfer", "upi", "cheque", "cash", "razorpay", "other"][int(0, 5)], allocations } });
    } else {
      out.push({ docType: "refund", doc: { ...REFUND, id: `rf-${k}`, amountPaise: int(1, 9_000_000), mode: ["bank_transfer", "cash", "razorpay"][int(0, 2)] } });
    }
  }
  return out;
}

describe("X5 balance property (I2)", () => {
  it("500 random documents: Σ AMOUNT = 0, ISDEEMEDPOSITIVE ⇔ AMOUNT < 0, Σ bills = party", () => {
    const c = ctx({ settings: multiSettings, zeroRatedEnabled: true });
    let built = 0;
    for (const d of randomDocs(500, 20261105)) {
      const v = ok(buildDoc(d, c));
      assertBalanced(v);
      const xml = renderVoucher(v, "Create", "prime3");
      const entries = xml.split(/LEDGERENTRIES\.LIST>/).filter((x) => x.includes("<LEDGERNAME>"));
      let sum = 0;
      for (const e of entries) {
        const a = e.match(/<AMOUNT>(-?\d+)\.(\d\d)<\/AMOUNT>/)!;
        const p = (a[1].startsWith("-") ? -1 : 1) * (Math.abs(Number(a[1])) * 100 + Number(a[2]));
        const deemed = e.match(/<ISDEEMEDPOSITIVE>(\w+)</)![1];
        expect(deemed === "Yes").toBe(p < 0);
        sum += p;
      }
      expect(sum).toBe(0);
      built += 1;
    }
    expect(built).toBe(500);
  });

  it("R/G: a builder that drops the round-off line is caught", () => {
    const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: 10_049 }], taxMode: "intra", gstRateBp: 1800 });
    expect(t.roundOffPaise).not.toBe(0);
    const v = ok(buildSales({ ...INV, ...t, items: [{ description: "x", sac: "998365", amountPaise: 10_049 }] }, ctx()));
    assertBalanced(v);
    const broken = { ...v, entries: v.entries.filter((e) => e.role !== "roundoff") };
    expect(() => assertBalanced(broken)).toThrow(/does not balance/);
  });
});

describe("X6–X7", () => {
  it("X6 splitExact sums exactly, ties to the earlier weight, and stays exact near MAX_PAISE", () => {
    expect(splitExact(99, [50, 50])).toEqual([50, 49]);
    expect(splitExact(1, [1, 1, 1])).toEqual([1, 0, 0]);
    const s = splitExact(2_147_483_647, [3, 7, 11]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(2_147_483_647);
    expect(splitExact(-101, [1, 1]).reduce((a, b) => a + b, 0)).toBe(-101);
    // two ledgers after a ₹0.01 document discount
    expect(splitExact(9_999, [5_000, 5_000]).reduce((a, b) => a + b, 0)).toBe(9_999);
  });
  it("X7 every GST state code yields a Tally state name", () => {
    for (const code of Object.keys(GST_STATE_CODES)) expect(tallyStateName(code)).toBeTruthy();
    expect(tallyStateName("27")).toBe("Maharashtra");
  });
});

describe("X8–X9 reading Tally", () => {
  it("X8 parseImportResponse: both shapes, line errors, bad replies, linear on a hostile body", () => {
    const a = parseImportResponse("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>4521</LASTVCHID></RESPONSE>");
    expect(a).toMatchObject({ created: 1, errors: 0, lastVchId: "4521" });
    const b = parseImportResponse("<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ALTERED>2</ALTERED><ERRORS>3</ERRORS><EXCEPTIONS>0</EXCEPTIONS></IMPORTRESULT></DATA></BODY><LINEERROR>Ledger &apos;Output CGST&apos; does not exist!</LINEERROR><LINEERROR>two</LINEERROR><LINEERROR>three</LINEERROR></ENVELOPE>");
    expect(b).toMatchObject({ altered: 2, errors: 3 });
    expect(b.lineErrors).toEqual(["Ledger 'Output CGST' does not exist!", "two", "three"]);
    expect(() => parseImportResponse("<RESPONSE>Unknown Request, cannot be processed</RESPONSE>")).toThrow(TallyReadError);
    expect(() => parseImportResponse("<html><body>nginx</body></html>")).toThrow(TallyReadError);
    try { parseImportResponse("<RESPONSE>Could not set 'SVCurrentCompany' to 'X'</RESPONSE>"); } catch (e) { expect((e as TallyReadError).kind).toBe("COMPANY_NOT_OPEN"); }
    const hostile = "<RESPONSE><CREATED>1</CREATED>" + "<LINEERROR>".repeat(50_000) + "x".repeat(400_000);
    const t0 = Date.now();
    parseImportResponse(hostile);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("X9 parseCollection: vouchers, companies, ledgers with &amp; and a GSTIN in LEDGSTREGDETAILS", () => {
    const v = parseCollection(`<ENVELOPE><VOUCHER REMOTEID="dsh-inv-1" VCHTYPE="Sales"><DATE>20261105</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV/26-27/0016</VOUCHERNUMBER><PARTYLEDGERNAME>Filmy Brands</PARTYLEDGERNAME><AMOUNT>-118000.00</AMOUNT><MASTERID>77</MASTERID><ISCANCELLED>No</ISCANCELLED></VOUCHER></ENVELOPE>`, "vouchers");
    expect(v[0]).toMatchObject({ number: "INV/26-27/0016", type: "Sales", remoteId: "dsh-inv-1", amountPaise: -11_800_000, cancelled: false, date: "2026-11-05", masterId: "77" });
    expect(parseCollection(`<ENVELOPE><COMPANY NAME="Digital Sukoon Private Limited"></COMPANY><COMPANY><NAME>Dashmani Media</NAME></COMPANY></ENVELOPE>`, "companies")).toEqual(["Digital Sukoon Private Limited", "Dashmani Media"]);
    const l = parseCollection(`<ENVELOPE><LEDGER NAME="A &amp; B Films"><PARENT>Sundry Debtors</PARENT><LEDGSTREGDETAILS.LIST><GSTIN>27aabcu9603r1zx</GSTIN></LEDGSTREGDETAILS.LIST></LEDGER></ENVELOPE>`, "ledgers");
    expect(l[0]).toEqual({ name: "A & B Films", parent: "Sundry Debtors", gstin: "27AABCU9603R1ZX" });
  });
});

describe("X10 the Tally URL guard", () => {
  const resolver = (map: Record<string, string[]>) => async (h: string) => (map[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  it("refuses loopback, metadata, user info, wrong schemes and ports, public and loopback-resolving names", async () => {
    const r = resolver({ localhost: ["127.0.0.1"], evil: ["127.0.0.1"], "pub.example": ["8.8.8.8"] });
    for (const u of ["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000", "http://169.254.169.254:9000", "http://0.0.0.0:9000",
      "http://user:pw@10.0.0.5:9000", "ftp://10.0.0.5:9000", "http://10.0.0.5:5432", "http://8.8.8.8:9000", "http://evil:9000", "http://pub.example:9000", "http://10.0.0.5:9000/path"]) {
      await expect(assertTallyTarget(u, r), u).rejects.toMatchObject({ code: "TALLY_URL_REFUSED" });
    }
  });
  it("accepts Tailscale and office addresses and pins the address it checked", async () => {
    expect((await assertTallyTarget("http://100.101.102.103:9000")).address).toBe("100.101.102.103");
    expect((await assertTallyTarget("http://192.168.1.20:9001")).port).toBe(9001);
    expect((await assertTallyTarget("http://tally-pc:9000", resolver({ "tally-pc": ["10.1.2.3"] }))).address).toBe("10.1.2.3");
  });
  it("R/G: every resolved address is checked — private then loopback is refused", async () => {
    await expect(assertTallyTarget("http://tally-pc:9000", resolver({ "tally-pc": ["10.1.2.3", "127.0.0.1"] }))).rejects.toMatchObject({ code: "TALLY_URL_REFUSED" });
  });
});

describe("X11 settings schema", () => {
  const base = { ledgers: { bank: "Bank" } };
  it("refuses duplicates and a shared company under legacy; old JSON still parses; {fy}", () => {
    const g = "27AAKCD3352K1ZF";
    expect(tallySettingsSchema.safeParse({ ...base, registrations: [{ gstin: g, tallyCompany: "DS" }, { gstin: g, tallyCompany: "DS" }] }).success).toBe(false);
    expect(tallySettingsSchema.safeParse({ ledgers: { bank: "output cgst" } }).success).toBe(false);
    expect(tallySettingsSchema.safeParse({ ...base, salesLedgers: [{ name: "A", sac: "998365", gstRateBp: 1800 }, { name: "B", sac: "998365", gstRateBp: 1800 }] }).success).toBe(false);
    expect(tallySettingsSchema.safeParse({ ...base, salesLedgers: [{ name: "A", sac: "998365", gstRateBp: 1800 }, { name: "a", sac: "998361", gstRateBp: 1800 }] }).success).toBe(true);
    expect(tallySettingsSchema.safeParse({ ...base, release: "legacy", registrations: [{ gstin: g, tallyCompany: "DS" }, { gstin: "06AAKCD3352K1ZJ", tallyCompany: "DS" }] }).success).toBe(false);
    expect(tallySettingsSchema.safeParse({ ...base, registrations: [{ gstin: g, tallyCompany: "Digital Sukoon" }, { gstin: "06AAKCD3352K1ZJ", tallyCompany: "digital sukoon" }] }).success).toBe(false);
    const old = tallySettingsSchema.parse({ booksFrom: "2026-11-01" });
    expect(old.ledgers.zeroRatedSales).toBeNull();
    expect(old.bankAllocations).toBe(true);
    expect(tdsLedgerName("TDS Receivable {fy}", "2026-11-20")).toBe("TDS Receivable 2026-27");
    expect(tdsLedgerName("TDS Receivable {fy}", "2027-03-31")).toBe("TDS Receivable 2026-27");
  });
});

describe("X12 the content hash (by role, never by ledger name)", () => {
  const h = (inv: InvoiceDoc, c = ctx()) => contentHash(ok(buildSales(inv, c)));
  it("R/G: renaming ledgers keeps every hash; facts change it; the IRN does not", () => {
    const renamed = tallySettingsSchema.parse({ ...SETTINGS, salesLedgers: [{ name: "Ad Sales", sac: "998365", gstRateBp: 1800 }], ledgers: { ...SETTINGS.ledgers, outputCgst: "CGST Out", outputSgst: "SGST Out", bank: "HDFC" } });
    expect(h(INV, ctx({ settings: renamed }))).toBe(h(INV));
    expect(contentHash(ok(buildReceipt(RCPT, ctx({ settings: renamed }))))).toBe(contentHash(ok(buildReceipt(RCPT, ctx()))));
    expect(h({ ...INV, totalPaise: INV.totalPaise + 1, roundOffPaise: 1 })).not.toBe(h(INV));
    expect(h({ ...INV, buyer: { ...INV.buyer, gstin: "27AAACB1234F1Z9" } })).not.toBe(h(INV));
    expect(h({ ...INV, status: "cancelled" })).not.toBe(h(INV));
    expect(h({ ...INV, poNumber: "OTHER" })).not.toBe(h(INV));
    expect(h({ ...INV, irn: "a".repeat(64) })).toBe(h(INV));
    expect(h({ ...INV, status: "paid" })).toBe(h(INV));
    expect(contentHash(ok(buildReceipt(RCPT_AFTER_CN, ctx())))).not.toBe(contentHash(ok(buildReceipt(RCPT, ctx()))));
  });
  it("pins the worked example's v1 hashes", () => {
    expect({
      inv: h(INV), rcpt: contentHash(ok(buildReceipt(RCPT, ctx()))), cn: contentHash(ok(buildCreditNote(CN, ctx()))), rf: contentHash(ok(buildRefund(REFUND, ctx()))),
    }).toEqual(PINNED);
  });
});
// Filled from the first run of the v1 builder; changing them means every document is re-sent as Alter.
const PINNED = {
  inv: "b85b3d1cadb462b7936d73288ceef7c55adfe742a60a092361f9bceed9dec4af",
  rcpt: "515504fc4bc7fce5d7c61e2c6152a9c93f9cd1f23147f571a1316f0090c37481",
  cn: "911989822c4a45c6c2365bcc573c28e5ec835a7fda8baa4fb9224c33ed73c39d",
  rf: "9b4260c7d565d662e2086a958c8ebe2b27592c1c8e90e82a602378ad2992548b",
};

describe("X13 the planner (I3)", () => {
  const last = (r: { docId: string; hash: string | null; partyAmountPaise: number }, action = "create"): [string, LastGood] => [r.docId, { action, contentHash: r.hash, partyAmountPaise: r.partyAmountPaise, runNo: 1, at: "x", runId: "r" }];
  const base = planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV }), doc({ docType: "receipt", doc: RCPT })] }));
  const [invRow, rcRow] = base.runRows;

  it("every row of the action table, in both modes", () => {
    const cases: Array<[string, Parameters<typeof planInput>[0], string, string]> = [
      ["live, none", { docs: [doc({ docType: "invoice", doc: INV })] }, "create", "create"],
      ["live, same hash", { docs: [doc({ docType: "invoice", doc: INV })], lastGood: new Map([last(invRow)]) }, "unchanged", "alter"],
      ["live, other hash", { docs: [doc({ docType: "invoice", doc: { ...INV, poNumber: "X" } })], lastGood: new Map([last(invRow)]) }, "alter", "alter"],
      ["cancelled invoice, none", { docs: [doc({ docType: "invoice", doc: { ...INV, status: "cancelled" } })] }, "create", "create"],
      ["voided receipt, none", { docs: [doc({ docType: "receipt", doc: { ...RCPT, status: "voided" } })] }, "skip", "skip"],
      ["cancelled, sent", { docs: [doc({ docType: "invoice", doc: { ...INV, status: "cancelled" } })], lastGood: new Map([last(invRow)]) }, "cancel", "cancel"],
      ["cancelled, already cancelled", { docs: [doc({ docType: "invoice", doc: { ...INV, status: "cancelled" } })], lastGood: new Map([last(invRow, "cancel")]) }, "unchanged", "unchanged"],
    ];
    for (const [name, over, newOnly, everything] of cases) {
      expect(planTally(planInput({ ...over, mode: "new_only" })).rows[0].action, `${name} / new_only`).toBe(newOnly);
      expect(planTally(planInput({ ...over, mode: "everything" })).rows[0].action, `${name} / everything`).toBe(everything);
    }
  });

  it("pull-in: a receipt's out-of-period invoice is added; a blocked one blocks the receipt", () => {
    const plan = planTally(planInput({ docs: [doc({ docType: "receipt", doc: RCPT }), doc({ docType: "invoice", doc: INV }, "candidate")] }));
    expect(plan.runRows.map((r) => `${r.number}:${r.action}:${r.reason}`)).toEqual(["INV/26-27/0016:create:needed", "RCPT/26-27/0021:create:new"]);
    const blocked = planTally(planInput({ docs: [doc({ docType: "receipt", doc: RCPT }), doc({ docType: "invoice", doc: { ...INV, placeOfSupplyCode: null, buyer: { ...INV.buyer, stateCode: null, gstin: null } } }, "candidate")] }));
    expect(blocked.rows.find((r) => r.docType === "receipt")).toMatchObject({ action: "blocked", blockCode: "DEPENDS_ON_UNSENT" });
    expect(blocked.rows.find((r) => r.docType === "invoice")).toMatchObject({ action: "blocked", blockCode: "PLACE_OF_SUPPLY_MISSING" });
  });

  it("R4: a receipt paying invoices of two Tally companies is blocked", () => {
    const other = { ...INV, id: "inv-hr", number: "INV/26-27/060", seller: { gstin: "06AAKCD3352K1ZJ", stateCode: "06" } };
    const half = { ...RCPT.allocations[0], amountPaise: 5_800_000, tdsPaise: 100_000 };
    const rc: ReceiptDoc = { ...RCPT, allocations: [half, { ...half, invoiceId: other.id, invoiceNumber: other.number, invoiceGstin: other.seller.gstin }] };
    const plan = planTally(planInput({ docs: [doc({ docType: "receipt", doc: rc }), doc({ docType: "invoice", doc: INV }), { d: { docType: "invoice", doc: other }, routeGstin: other.seller.gstin, tallyCompany: "Other Co", origin: "candidate" }] }));
    expect(plan.rows.find((r) => r.docType === "receipt")).toMatchObject({ action: "blocked", blockCode: "RECEIPT_SPANS_COMPANIES" });
  });

  it("coverage: one row per selected document; earlier docs only when changed", () => {
    const docs = [doc({ docType: "invoice", doc: INV }), doc({ docType: "receipt", doc: { ...RCPT, status: "voided" } }), doc({ docType: "credit_note", doc: CN }), doc({ docType: "refund", doc: REFUND })];
    const plan = planTally(planInput({ docs, mode: "everything" }));
    expect(plan.rows.length).toBe(docs.length);
    const unchangedEarlier = planTally(planInput({ docs: [doc({ docType: "receipt", doc: RCPT }, "earlier")], lastGood: new Map([last(rcRow)]) }));
    expect(unchangedEarlier.rows.length).toBe(0);
  });

  it("export/SEZ invoices stay held back (calibration gate) and are listed; the configured ledger is used once calibrated", () => {
    const sez = { ...INV, taxMode: "none", cgstPaise: 0, sgstPaise: 0, totalPaise: INV.taxablePaise };
    const s = tallySettingsSchema.parse({ ...SETTINGS, ledgers: { ...SETTINGS.ledgers, zeroRatedSales: "Sales - Export / SEZ" } });
    const plan = planTally(planInput({ settings: s, docs: [doc({ docType: "invoice", doc: sez })] }));
    expect(plan.rows[0]).toMatchObject({ action: "blocked", blockCode: "ZERO_RATED_UNSUPPORTED" });
    expect(plan.issues.find((i) => i.code === "ZERO_RATED_UNSUPPORTED")?.number).toBe(INV.number);
    const v = ok(buildSales(sez, ctx({ settings: s, zeroRatedEnabled: true })));
    assertBalanced(v);
    expect(v.entries.map((e) => e.ledger)).toEqual(["Filmy Brands Private Limited", "Sales - Export / SEZ"]);
  });

  it("late cancellation is an ack; first export is an ack; acks and blocks change nothing in the hash inputs", () => {
    const oct = { ...INV, issueDate: "2026-10-20", status: "cancelled", cancelledDay: "2026-11-15" };
    const plan = planTally(planInput({ from: "2026-10-01", to: "2026-10-31", booksFrom: "2026-10-01", docs: [doc({ docType: "invoice", doc: oct })], lastGood: new Map([last(invRow)]), firstExport: true }));
    expect(plan.issues.filter((i) => i.severity === "ack").map((i) => i.code).sort()).toEqual(["FIRST_EXPORT_OVERLAP", "LATE_CANCELLATION"]);
  });
});

describe("X14 tax rounding info", () => {
  it("two ledgers whose per-ledger rounding differs by a paisa → info; one ledger → none", () => {
    const s = tallySettingsSchema.parse({ ...SETTINGS, salesLedgers: [{ name: "A", sac: "998365", gstRateBp: 1800 }, { name: "B", sac: "998361", gstRateBp: 1800 }] });
    // 105 + 105 paise at 9 % CGST: 18.9 → 19 on the document, 9.45 → 9 on each ledger.
    const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: 105 }, { quantity: 1, unitPricePaise: 105 }], taxMode: "intra", gstRateBp: 1800, roundToRupee: false });
    const inv = { ...INV, ...t, items: [{ description: "a", sac: "998365", amountPaise: 105 }, { description: "b", sac: "998361", amountPaise: 105 }] };
    const two = planTally(planInput({ settings: s, docs: [doc({ docType: "invoice", doc: inv })] }));
    expect(two.issues.map((i) => i.code)).toContain("TALLY_TAX_ROUNDING");
    const one = planTally(planInput({ docs: [doc({ docType: "invoice", doc: INV })] }));
    expect(one.issues.map((i) => i.code)).not.toContain("TALLY_TAX_ROUNDING");
  });
});

describe("X15 party naming", () => {
  const c = (over: Partial<{ id: string; legalName: string | null; companyName: string; gstin: string | null; city: string | null }> = {}) =>
    ({ id: "aaaaaaaa-0000-4000-8000-000000000000", legalName: "ABC LTD", companyName: "ABC", gstin: "27AABCU9603R1ZX", city: "Pune", ...over });
  it("collisions get a GSTIN, city or id suffix; case and spaces collide; the same GSTIN shares", () => {
    const taken = [{ key: ledgerKey("abc  ltd"), gstin: "29AAACB1234F1Z9", clientId: "other" }];
    expect(proposeLedgerName(c(), taken, new Set())).toBe("ABC LTD (27AABCU9603R1ZX)");
    expect(proposeLedgerName(c({ gstin: null }), taken, new Set())).toBe("ABC LTD (Pune)");
    expect(proposeLedgerName(c({ gstin: null, city: null }), taken, new Set())).toBe("ABC LTD (aaaaaaaa)");
    expect(proposeLedgerName(c(), [{ key: "abc ltd", gstin: "27AABCU9603R1ZX", clientId: "other" }], new Set())).toBe("ABC LTD");
    expect(proposeLedgerName(c({ legalName: "Output CGST" }), [], new Set(["output cgst"]))).toBe("Output CGST (27AABCU9603R1ZX)");
    expect(proposeLedgerName(c({ legalName: "  ", companyName: "" }), [], new Set())).toBeNull();
  });
});
