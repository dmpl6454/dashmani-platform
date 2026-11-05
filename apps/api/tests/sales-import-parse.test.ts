/**
 * Swipe import (spec-import §8, T-01–T-13): the pure half — reading the file, finding the columns,
 * reading values, matching clients and building the check. No database, no HTTP.
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { importOptionsSchema, lineAmountPaise, sellerProfileSchema, type ImportOptions } from "@dashmani/shared";
import { readSource } from "../src/services/sales/import/read";
import { amountLevels, autoMap, detectHeaderRow, normaliseHeader } from "../src/services/sales/import/fields";
import { detectDateOrder, gstinChecksumOk, gstinShapeOk, invoiceKey, normaliseParty, parseAmount, parseDay, parseRateBp, parseStateCode, parseSwipeStatus } from "../src/services/sales/import/values";
import { buildClientIndex, matchGroup, type ClientIndexRow } from "../src/services/sales/import/match";
import { buildPlan, extractKeys, type PlanContext, type PlanRow } from "../src/services/sales/import/plan";
import type { ImportMapping } from "../src/services/sales/import/fields";

// The seller mirrors prod: Mumbai principal INV/4 digits, Gurugram branch INV/3 digits.
export const SELLER = sellerProfileSchema.parse({
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K",
  addressLine1: "702, Parinee I, Andheri West", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053",
  invoicePrefix: "INV", creditNotePrefix: "CN", serialDigits: 4,
  branches: [{ label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Hunch Circle, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "INV", creditNotePrefix: "CNHR", serialDigits: 3 }],
});

const HEAD = "Invoice Number,Invoice Date,Due Date,Customer Name,Customer GSTIN,Place of Supply,Item,HSN/SAC,Qty,Rate,Taxable Value,CGST,SGST,IGST,Total,Amount Paid,TDS,Balance,Status,PO Number,Notes";
/** §4.16 worked example. */
export const WORKED = [
  "Swipe - Sales Report,,,",
  "Generated on 05-11-2026,,,",
  HEAD,
  `INV/24-25/0102,12/06/2024,27/06/2024,Filmy Brands Pvt. Ltd.,27AAPFU0939F1ZV,27-Maharashtra,Instagram reel,998365,1,"1,00,000.00","1,00,000.00","9,000.00","9,000.00",0,"1,18,000.00","1,08,000.00","10,000.00",0.00,Paid,PO-77,`,
  `INV/26-27/059,02/10/2026,17/10/2026,Hunch Foods LLP,06AAXFH1234K1Z3,06-Haryana,Reel package,998365,2,"25,000.00","50,000.00","5,611.10","5,611.10",0,"73,568.00",0,0,"73,568.00",Unpaid,,`,
  `INV/26-27/059,02/10/2026,17/10/2026,Hunch Foods LLP,06AAXFH1234K1Z3,06-Haryana,Story add-on,998365,1,"12,345.50","12,345.50","5,611.10","5,611.10",0,"73,568.00",0,0,"73,568.00",Unpaid,,`,
  `INV/26-27/0012,20/05/2026,04/06/2026,Saffron Media Pvt Ltd,29AAGCS5678L1ZH,29-Karnataka,YouTube integration,998365,1,"40,000.00","40,000.00",0,0,"7,200.00","47,200.00","46,400.00",800.00,0.00,Paid,,`,
].join("\r\n");

const client = (id: string, companyName: string, gstin: string | null, extra: Partial<ClientIndexRow> = {}): ClientIndexRow => ({
  id, companyName, createdAt: new Date("2025-01-01"),
  billingProfile: gstin ? { legalName: companyName, gstin, pan: gstin.slice(2, 12), stateCode: gstin.slice(0, 2), updatedAt: new Date("2025-06-01") } : null,
  _count: { salesInvoices: 0 }, ...extra,
});

export const CLIENTS: ClientIndexRow[] = [client("c-filmy", "Filmy Brands", "27AAPFU0939F1ZV"), client("c-saffron", "Saffron Media", null)];

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    company: "dspl", companyName: "Digital Sukoon Private Limited", today: "2026-11-05", seller: SELLER, sellerMissing: [],
    otherCompany: { name: "Dashmani Media Private Limited", gstins: ["27AAJCD7425L1Z8"], formats: [{ prefix: "DM", digits: 4 }] },
    clients: CLIENTS, existing: [], sequences: { "invoice:2026-27": 16, "invoice@06AAKCD3352K1ZJ:2026-27": 60 }, portalNumbers: [],
    sameFileApplied: 0, columnsTruncated: false, fileName: "swipe.csv", ...over,
  };
}

const OWN = new Set(["27AAKCD3352K1ZF", "06AAKCD3352K1ZJ", "27AAJCD7425L1Z8"]);

function plan(csv: string, o: { options?: Partial<ImportOptions>; ctx?: Partial<PlanContext>; choices?: Record<string, string>; mapping?: ImportMapping } = {}) {
  const src = readSource(Buffer.from(csv), "swipe.csv", null, 20_000);
  const idx = detectHeaderRow(src.rows)!;
  const headerRow = idx + 1;
  const mapping = o.mapping ?? autoMap(src.rows[idx], src.rows.slice(headerRow), OWN).mapping;
  const input = { grid: src.rows, headerRow, mapping, options: importOptionsSchema.parse(o.options ?? {}), clientChoices: o.choices ?? {} };
  return buildPlan(input, ctx(o.ctx));
}
const byKey = (rows: PlanRow[], key: string) => rows.find((r) => r.key === key)!;
const codes = (r: PlanRow) => r.issues.map((i) => i.code);

/** A one-invoice-per-row CSV with the §4.16 headings. */
function rowsCsv(rows: string[]) {
  return [HEAD, ...rows].join("\n");
}
const row = (o: { no: string; date?: string; name?: string; gstin?: string; pos?: string; qty?: string; rate?: string; taxable: string; cgst?: string; sgst?: string; igst?: string; total: string; paid?: string; tds?: string; bal?: string; status?: string }) =>
  [o.no, o.date ?? "12/06/2024", "", o.name ?? "Filmy Brands Pvt. Ltd.", o.gstin ?? "27AAPFU0939F1ZV", o.pos ?? "27", "Reel", "998365", o.qty ?? "1", o.rate ?? o.taxable, o.taxable,
    o.cgst ?? "0", o.sgst ?? "0", o.igst ?? "0", o.total, o.paid ?? "0", o.tds ?? "0", o.bal ?? "", o.status ?? "", "", ""].map((c) => (c.includes(",") ? `"${c}"` : c)).join(",");

describe("T-01 CSV reading", () => {
  it("handles a BOM, ; delimiter, quotes, \"\", a newline in quotes and CRLF; 0016 stays text", () => {
    const csv = "﻿Invoice No;Customer;Notes\r\nINV/26-27/0016;\"Acme; Co\";\"said \"\"hi\"\"\nthen left\"\r\n0016;B;x\r\n";
    const t = readSource(Buffer.from(csv), "x.csv", null, 100);
    expect(t.kind).toBe("csv");
    expect(t.rows[0]).toEqual(["Invoice No", "Customer", "Notes"]);
    expect(t.rows[1]).toEqual(["INV/26-27/0016", "Acme; Co", "said \"hi\"\nthen left"]);
    expect(t.rows[2][0]).toBe("0016");
  });
  it("refuses HTML named .csv and a workbook named .csv", () => {
    expect(() => readSource(Buffer.from("<html><table><tr><td>x</td></tr></table></html>"), "x.csv", null, 100)).toThrow(/could not be read/);
    const ws = XLSX.utils.aoa_to_sheet([["a"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    expect(() => readSource(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "x.csv", null, 100)).toThrow(/could not be read/);
  });
});

describe("T-02 parseAmount", () => {
  it("reads Indian grouping, string-arithmetic paise, brackets, blanks and a 3rd decimal", () => {
    expect(parseAmount("₹1,23,456.78")).toEqual({ paise: 12345678 });
    expect(parseAmount("0.29")).toEqual({ paise: 29 }); // Number("0.29") * 100 = 28.999…
    expect(parseAmount("(1,234.00)")).toEqual({ paise: -123400 });
    expect(parseAmount("-")).toEqual({ blank: true });
    expect(parseAmount("NA")).toEqual({ blank: true });
    expect(parseAmount("12.345")).toEqual({ paise: 1235, rounded: true });
    expect(parseAmount("12.3400")).toEqual({ paise: 1234 });
    expect("error" in parseAmount("12 apples")).toBe(true);
  });
});

describe("T-03 dates", () => {
  it("reads every shape and refuses an impossible day", () => {
    expect(parseDay("05/11/2026", "dmy")).toBe("2026-11-05");
    expect(parseDay("05/11/2026", "mdy")).toBe("2026-05-11");
    expect(parseDay("05-Nov-2026")).toBe("2026-11-05");
    expect(parseDay("5 Nov 2026")).toBe("2026-11-05");
    expect(parseDay("Nov 5, 2026")).toBe("2026-11-05");
    expect(parseDay("46331")).toBe("2026-11-05");
    expect(parseDay("2026-02-31")).toBeNull();
    expect(parseDay("31/02/2026")).toBeNull();
  });
  it("detects the order: dmy, mdy, conflict, assumed", () => {
    expect(detectDateOrder(["20/05/2026", "01/02/2026"])).toMatchObject({ order: "dmy", conflict: false, assumed: false });
    expect(detectDateOrder(["05/20/2026"])).toMatchObject({ order: "mdy", conflict: false });
    expect(detectDateOrder(["20/05/2026", "05/20/2026"])).toMatchObject({ conflict: true });
    expect(detectDateOrder(["05/11/2026"])).toMatchObject({ order: "dmy", assumed: true });
  });
});

describe("T-04 XLSX reading", () => {
  it("turns a date cell into its day with no timezone shift, keeps text 0016 and removes float noise", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Invoice Number", "Invoice Date", "Customer Name", "Taxable Value"], ["0016", 0, "Acme", 1234.5599999]]);
    ws.B2 = { t: "n", v: 45455, z: "dd/mm/yyyy" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sales");
    const t = readSource(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "s.xlsx", null, 100);
    expect(t.kind).toBe("xlsx");
    expect(t.rows[1]).toEqual(["0016", "2024-06-12", "Acme", "1234.56"]);
  });
});

describe("T-05 headings and mapping", () => {
  it("skips a 2-line preamble, maps the 21 §4.16 headings as auto, and refuses a file with no headings", () => {
    const t = readSource(Buffer.from(WORKED), "s.csv", null, 100);
    expect(detectHeaderRow(t.rows)).toBe(2);
    const m = autoMap(t.rows[2], t.rows.slice(3), OWN);
    const want = { number: 0, issueDate: 1, dueDate: 2, customerName: 3, customerGstin: 4, placeOfSupply: 5, itemName: 6, hsnSac: 7, quantity: 8, rate: 9, taxable: 10, cgst: 11, sgst: 12, igst: 13, total: 14, amountPaid: 15, tds: 16, balance: 17, status: 18, poNumber: 19, notes: 20 };
    expect(m.mapping).toMatchObject(want);
    for (const f of Object.keys(want)) expect(m.how[f as keyof typeof want]).toBe("auto");
    expect(detectHeaderRow([["a", "b"], ["1", "2"]])).toBeNull();
    expect(normaliseHeader("Invoice No.")).toBe("invoice no");
    expect(normaliseHeader("HSN/SAC")).toBe("hsn sac");
  });
  it("Due Date beats Date; of two GSTIN columns the company's own is the seller's", () => {
    const rows = [["Invoice No", "Date", "Due Date", "Customer", "GSTIN", "Company GSTIN", "Taxable"], ["INV/26-27/0001", "01/05/2026", "15/05/2026", "Acme", "27AAPFU0939F1ZV", "27AAKCD3352K1ZF", "100"]];
    const m = autoMap(rows[0], rows.slice(1), OWN);
    expect(m.mapping.dueDate).toBe(2);
    expect(m.mapping.issueDate).toBe(1);
    expect(m.mapping.customerGstin).toBe(4);
    expect(m.mapping.sellerGstin).toBe(5);
    const swapped = [["Invoice No", "Invoice Date", "Customer", "GSTIN A", "GSTIN B", "Taxable"], ["INV/26-27/0001", "01/05/2026", "Acme", "27AAKCD3352K1ZF", "27AAPFU0939F1ZV", "100"]];
    const m2 = autoMap(swapped[0], swapped.slice(1), OWN);
    expect(m2.mapping.sellerGstin).toBe(3);
    expect(m2.mapping.customerGstin).toBe(4);
  });
});

describe("T-06 amount levels", () => {
  const map: ImportMapping = { taxable: 0, cgst: 1, sgst: 2, total: 3 };
  it("§4.16: taxable per item, total per invoice", () => {
    const g = [[["50000", "5611.10", "5611.10", "73568"], ["12345.50", "5611.10", "5611.10", "73568"]]];
    expect(amountLevels(g, map).levels).toMatchObject({ taxable: "line", cgst: "invoice", total: "invoice" });
  });
  it("two equal item lines are line-level by the arithmetic tie-break", () => {
    const g = [[["100000", "9000", "9000", "236000"], ["100000", "9000", "9000", "236000"]]];
    const lv = amountLevels(g, map);
    expect(lv.levels).toMatchObject({ taxable: "line", cgst: "line", sgst: "line", total: "invoice" });
  });
  it("one row per invoice → invoice-level", () => {
    const lv = amountLevels([[["100", "9", "9", "118"]]], map);
    expect(lv.oneRowPerInvoice).toBe(true);
    expect(lv.levels.taxable).toBe("invoice");
  });
});

describe("T-07 GSTIN and party names", () => {
  it("checks the GSTN check digit", () => {
    for (const g of ["27AAKCD3352K1ZF", "06AAKCD3352K1ZJ", "27AAJCD7425L1Z8", "27AAPFU0939F1ZV", "06AAXFH1234K1Z3", "29AAGCS5678L1ZH"]) expect(gstinChecksumOk(g), g).toBe(true);
    expect(gstinChecksumOk("27AABCU9603R1ZX")).toBe(false);
    expect(gstinShapeOk("27aabcu9603r1zx")).toBe(true);
    expect(gstinShapeOk("27AABCU9603")).toBe(false);
  });
  it("normalises party names", () => {
    expect(normaliseParty("M/s. Filmy Brands Pvt. Ltd.")).toBe("filmy brands");
    expect(normaliseParty("FILMY BRANDS PRIVATE LIMITED")).toBe("filmy brands");
    expect(normaliseParty("The Hunch & Co LLP")).toBe("hunch and");
  });
  it("reads keys, states, statuses and rates", () => {
    expect(invoiceKey("'inv/26-27/ 0016 ")).toEqual({ key: "INV/26-27/0016", number: "inv/26-27/0016", ok: true });
    expect(invoiceKey("INV/2026-27/000000016").ok).toBe(false);
    expect(parseStateCode("27-Maharashtra")).toBe("27");
    expect(parseStateCode("Maharashtra (27)")).toBe("27");
    expect(parseStateCode("New Delhi")).toBe("07");
    expect(parseStateCode("Other Countries")).toBe("EXPORT");
    expect(parseSwipeStatus("Partially Paid").status).toBe("partial");
    expect(parseSwipeStatus("weird").unknown).toBe(true);
    expect(parseRateBp("18%")).toBe(1800);
    expect(parseRateBp("0.18")).toBe(1800);
  });
});

describe("T-09 / T-16 the §4.16 worked example", () => {
  it("plans the three invoices exactly as the spec's table", () => {
    const p = plan(WORKED);
    expect(p.summary.blockers).toEqual([]);
    expect(p.rows.map((r) => [r.key, r.outcome])).toEqual([
      ["INV/24-25/0102", "ready"], ["INV/26-27/0012", "ready"], ["INV/26-27/059", "ready"],
    ]);
    expect(p.summary.notices.map((n) => n.code)).toContain("PAID_TDS_DETECTED");
    expect(p.summary.paidIncludesTds).toBe(false);

    const a = byKey(p.rows, "INV/24-25/0102").plan.invoice!;
    expect(a.registration).toMatchObject({ gstin: "27AAKCD3352K1ZF", claimSeries: true });
    expect(a).toMatchObject({ taxMode: "intra", gstRateBp: 1800, issueDate: "2024-06-12", dueDate: "2024-06-27", poNumber: "PO-77" });
    expect(a.totals).toMatchObject({ taxablePaise: 10_000_000, cgstPaise: 900_000, sgstPaise: 900_000, totalPaise: 11_800_000, roundOffPaise: 0, source: "stated" });
    expect(a.payment).toMatchObject({ cashPaise: 10_800_000, tdsPaise: 1_000_000, paidOn: "2024-06-12", number: "SW-INV/24-25/0102" });
    expect(a.client).toMatchObject({ clientId: "c-filmy", decision: "gstin" });
    expect(codes(byKey(p.rows, "INV/24-25/0102"))).toEqual(expect.arrayContaining(["PAID_ON_DEFAULTED", "TDS_SECTION_GUESS"]));

    const b = byKey(p.rows, "INV/26-27/059").plan.invoice!;
    expect(b.registration).toMatchObject({ gstin: "06AAKCD3352K1ZJ", claimSeries: true });
    expect(b.lines.map((l) => [l.quantity, l.unitPricePaise, l.amountPaise])).toEqual([[2, 2_500_000, 5_000_000], [1, 1_234_550, 1_234_550]]);
    expect(b.totals).toMatchObject({ taxablePaise: 6_234_550, cgstPaise: 561_110, sgstPaise: 561_110, roundOffPaise: 30, totalPaise: 7_356_800 });
    expect(b.payment).toBeNull();
    expect(b.client).toMatchObject({ clientId: null, decision: "new" });

    const c = byKey(p.rows, "INV/26-27/0012").plan.invoice!;
    expect(c.registration).toMatchObject({ gstin: "27AAKCD3352K1ZF", claimSeries: true });
    expect(c).toMatchObject({ taxMode: "inter", gstRateBp: 1800 });
    expect(c.payment).toMatchObject({ cashPaise: 4_640_000, tdsPaise: 80_000 });
    expect(c.client).toMatchObject({ clientId: "c-saffron", decision: "name" });

    const reg = p.summary.byRegistration.map((r) => [r.sequenceKey, r.nextBefore, r.nextAfter, r.live]);
    expect(reg).toEqual(expect.arrayContaining([
      ["invoice:2024-25", "INV/24-25/0001", "INV/24-25/0103", false],
      ["invoice@06AAKCD3352K1ZJ:2026-27", "INV/26-27/060", "INV/26-27/060", true],
      ["invoice:2026-27", "INV/26-27/0016", "INV/26-27/0016", true],
    ]));
    expect(p.summary.liveSeriesMoves).toEqual([]);
    const fy = p.summary.byFy.map((f) => [f.fy, f.invoices, f.b2bTaxablePaise, f.cgstPaise + f.sgstPaise + f.igstPaise, f.totalPaise]);
    expect(fy).toEqual([["2024-25", 1, 10_000_000, 1_800_000, 11_800_000], ["2026-27", 2, 10_234_550, 1_842_220, 12_076_800]]);
  });

  it("T-09 registrations: Billed-from conflict, format as weak evidence, other company, intra without registration", () => {
    const conflict = plan(WORKED, { options: { registration: "27AAKCD3352K1ZF" } });
    expect(codes(byKey(conflict.rows, "INV/26-27/059"))).toContain("REGISTRATION_CONFLICT");
    const strongMumbai = plan(rowsCsv([row({ no: "INV/26-27/061", date: "01/10/2026", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    const r = strongMumbai.rows[0];
    expect(r.plan.view.registration).toMatchObject({ gstin: "27AAKCD3352K1ZF", claimSeries: false });
    expect(codes(r)).toContain("NUMBER_NOT_IN_SERIES");
    const inter3 = plan(rowsCsv([row({ no: "INV/26-27/061", date: "01/10/2026", gstin: "29AAGCS5678L1ZH", pos: "29", taxable: "100", igst: "18", total: "118" })]));
    expect(inter3.rows[0].plan.view.registration?.gstin).toBe("06AAKCD3352K1ZJ");
    expect(codes(inter3.rows[0])).toContain("REGISTRATION_ASSUMED");
    const dm = plan(rowsCsv([row({ no: "DM/26-27/0005", date: "01/10/2026", gstin: "29AAGCS5678L1ZH", pos: "29", taxable: "100", igst: "18", total: "118" })]));
    expect(codes(dm.rows[0])).toContain("OTHER_COMPANY");
    const ka = plan(rowsCsv([row({ no: "INV/26-27/0020", date: "01/10/2026", gstin: "29AAGCS5678L1ZH", pos: "29", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    expect(codes(ka.rows[0])).toContain("INTRA_WITHOUT_REGISTRATION");
  });
});

describe("T-10 arithmetic", () => {
  const one = (o: Parameters<typeof row>[0], opts?: Parameters<typeof plan>[1]) => plan(rowsCsv([row(o)]), opts).rows[0];
  it("per-line rounding within tolerance is info; unequal halves and a total ₹50 over are errors", () => {
    expect(codes(one({ no: "INV/24-25/0001", taxable: "100.10", cgst: "9.00", sgst: "9.00", total: "118.10" }))).toContain("TAX_ROUNDED_PER_LINE");
    expect(codes(one({ no: "INV/24-25/0001", taxable: "1000", cgst: "90", sgst: "95", total: "1185" }))).toContain("CGST_SGST_UNEQUAL");
    expect(codes(one({ no: "INV/24-25/0001", taxable: "1000", cgst: "90", sgst: "90", total: "1230" }))).toContain("TOTAL_DOESNT_ADD_UP");
  });
  it("a fractional quantity becomes 1 × the line amount; every line keeps qty × unit − discount", () => {
    const q = plan(rowsCsv([row({ no: "INV/24-25/0002", qty: "1.5", rate: "12000", taxable: "18000", cgst: "1620", sgst: "1620", total: "21240" })])).rows[0];
    expect(codes(q)).toContain("QTY_FRACTION");
    const l = q.plan.invoice!.lines[0];
    expect(l).toMatchObject({ quantity: 1, unitPricePaise: 1_800_000 });
    expect(l.description).toContain("1.5 ×");
    for (const r of plan(WORKED).rows) for (const x of r.plan.invoice!.lines) expect(x.amountPaise).toBe(lineAmountPaise(x));
  });
  it("lines ₹0.40 short of the stated taxable value: the last line absorbs it (LINE_ADJUSTED)", () => {
    const csv = [["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Item", "Qty", "Rate", "Taxable Value", "CGST", "SGST", "Total"],
      ["INV/24-25/0003", "12/06/2024", "Filmy Brands", "27AAPFU0939F1ZV", "A", "1", "100.00", "300.00", "27.00", "27.00", "354.00"],
      ["INV/24-25/0003", "12/06/2024", "Filmy Brands", "27AAPFU0939F1ZV", "B", "1", "199.60", "300.00", "27.00", "27.00", "354.00"]].map((r) => r.join(",")).join("\n");
    const r = plan(csv).rows[0];
    expect(codes(r)).toContain("LINE_ADJUSTED");
    const inv = r.plan.invoice!;
    expect(inv.lines.map((x) => x.amountPaise)).toEqual([10_000, 20_000]);
    expect(inv.totals).toMatchObject({ subtotalPaise: 30_000, discountPaise: 0, taxablePaise: 30_000, totalPaise: 35_400, roundOffPaise: 0 });
    for (const x of inv.lines) expect(x.amountPaise).toBe(lineAmountPaise(x));
  });
  it("mixed GST rates, cess, and the derived cases (b)–(e)", () => {
    const mixed = [["Invoice Number", "Invoice Date", "Customer Name", "Taxable Value", "GST Rate", "Total"],
      ["INV/24-25/0009", "12/06/2024", "Acme", "100", "18%", "118"], ["INV/24-25/0009", "12/06/2024", "Acme", "100", "5%", "105"]].map((r) => r.join(",")).join("\n");
    expect(codes(plan(mixed).rows[0])).toContain("MIXED_GST_RATES");
    const cess = [["Invoice Number", "Invoice Date", "Customer Name", "Taxable Value", "IGST", "Cess", "Total"], ["INV/24-25/0009", "12/06/2024", "Acme", "100", "18", "1", "119"]].map((r) => r.join(",")).join("\n");
    expect(codes(plan(cess).rows[0])).toContain("CESS_OR_TCS");
    // (b) only a total-tax column: split by the registration and the place of supply
    const b = [["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Taxable Value", "Total Tax", "Total"], ["INV/24-25/0009", "12/06/2024", "Acme", "27AAPFU0939F1ZV", "100.00", "18.01", "118.01"]].map((r) => r.join(",")).join("\n");
    const pb = plan(b).rows[0];
    expect(pb.plan.invoice!.totals).toMatchObject({ cgstPaise: 900, sgstPaise: 901, source: "derived" });
    expect(codes(pb)).toContain("TAX_SPLIT");
    // (c) taxes, no total
    const c = [["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Taxable Value", "IGST"], ["INV/24-25/0009", "12/06/2024", "Acme", "29AAGCS5678L1ZH", "100.40", "18.07"]].map((r) => r.join(",")).join("\n");
    const pc = plan(c).rows[0];
    expect(pc.plan.invoice!.totals).toMatchObject({ totalPaise: 11_800, roundOffPaise: -47 });
    expect(codes(pc)).toContain("TOTAL_DERIVED");
    // (d) total, no tax column
    const d = [["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Taxable Value", "Total"], ["INV/24-25/0009", "12/06/2024", "Acme", "29AAGCS5678L1ZH", "1000", "1180"]].map((r) => r.join(",")).join("\n");
    const pd = plan(d).rows[0];
    expect(pd.plan.invoice).toMatchObject({ taxMode: "inter", gstRateBp: 1800 });
    expect(pd.plan.invoice!.totals.igstPaise).toBe(18_000);
    expect(codes(pd)).toContain("TAX_DERIVED");
    // (e) neither: computed, and a warning that must be acknowledged
    const e = [["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Taxable Value"], ["INV/24-25/0009", "12/06/2024", "Acme", "29AAGCS5678L1ZH", "1000"]].map((r) => r.join(",")).join("\n");
    const pe = plan(e).rows[0];
    expect(pe.outcome).toBe("warning");
    expect(codes(pe)).toContain("COMPUTED_TOTALS");
    expect(pe.plan.invoice!.totals).toMatchObject({ igstPaise: 18_000, totalPaise: 118_000, source: "computed" });
  });
});

describe("T-11 settlement and TDS", () => {
  const one = (o: Parameters<typeof row>[0], opts?: Parameters<typeof plan>[1]) => plan(rowsCsv([row(o)]), opts);
  const base = { no: "INV/24-25/0001", taxable: "100000", cgst: "9000", sgst: "9000", total: "118000" };
  it("decides paid-includes-TDS from the balance, or from paid + TDS over the total", () => {
    expect(one({ ...base, paid: "108000", tds: "10000", bal: "0" }).summary.paidIncludesTds).toBe(false);
    expect(one({ ...base, paid: "118000", tds: "10000", bal: "0" }).summary.paidIncludesTds).toBe(true);
    const noBal = [HEAD.replace(",Balance", ""), row({ ...base, paid: "118000", tds: "10000" }).replace(/,10000,,/, ",10000,")].join("\n");
    const h2 = plan(noBal);
    expect(h2.summary.paidIncludesTds).toBe(true);
    expect(h2.rows[0].plan.invoice!.payment).toMatchObject({ cashPaise: 10_800_000, tdsPaise: 1_000_000 });
  });
  it("conflicting evidence blocks", () => {
    const p = plan(rowsCsv([row({ ...base, paid: "108000", tds: "10000", bal: "0" }), row({ ...base, no: "INV/24-25/0002", paid: "118000", tds: "10000", bal: "0" })]));
    expect(p.summary.blockers.map((b) => b.code)).toContain("PAID_TDS_AMBIGUOUS");
  });
  it("Paid but short → STATUS_CONFLICT and part-paid; TDS 10% of taxable is 194J; 10% of the total is on the gross", () => {
    const short = one({ ...base, paid: "108000", status: "Paid" }).rows[0];
    expect(codes(short)).toContain("STATUS_CONFLICT");
    expect(short.plan.invoice!.payment).toMatchObject({ cashPaise: 10_800_000, tdsPaise: 0 });
    expect(codes(one({ ...base, paid: "108000", tds: "10000", bal: "0" }).rows[0])).toContain("TDS_SECTION_GUESS");
    expect(codes(one({ ...base, paid: "106200", tds: "11800", bal: "0" }).rows[0])).toContain("TDS_ON_GROSS");
  });
});

describe("T-12 client matching", () => {
  const idx = (rows: ClientIndexRow[]) => buildClientIndex(rows);
  it("GSTIN beats name; two clients with one GSTIN must be chosen", () => {
    const i = idx([client("a", "Other Name", "27AAPFU0939F1ZV"), client("b", "Filmy Brands", null)]);
    expect(matchGroup(i, { groupKey: "gstin:27AAPFU0939F1ZV", name: "Filmy Brands", gstin: "27AAPFU0939F1ZV" }).decision).toMatchObject({ action: "match", clientId: "a", by: "gstin" });
    const two = idx([client("a", "X", "27AAPFU0939F1ZV"), client("b", "Y", "27AAPFU0939F1ZV")]);
    expect(matchGroup(two, { groupKey: "g", name: "Z", gstin: "27AAPFU0939F1ZV" }).decision.action).toBe("choose");
  });
  it("same name, different PAN → a new client and a warning; same PAN elsewhere and fuzzy names are only offered", () => {
    const i = idx([client("a", "Filmy Brands", "27AAACB1234F1Z9")]);
    const m = matchGroup(i, { groupKey: "g", name: "Filmy Brands Pvt Ltd", gstin: "27AAPFU0939F1ZV" });
    expect(m.decision).toMatchObject({ action: "create", by: "auto" });
    expect(m.issues.map((x) => x.code)).toContain("NAME_GSTIN_DIFFER");
    const samePan = idx([client("a", "Totally Different", "06AAPFU0939F1ZX")]);
    const sp = matchGroup(samePan, { groupKey: "g", name: "Filmy", gstin: "27AAPFU0939F1ZV" });
    expect(sp.decision.action).toBe("create");
    expect(sp.candidates[0]?.reason).toMatch(/Same PAN/);
    const fuzzy = idx([client("a", "Hunch Foods India", null)]);
    const fz = matchGroup(fuzzy, { groupKey: "g", name: "Hunch Foods India LLP Mumbai", gstin: null });
    expect(fz.decision.action).toBe("create");
  });
  it("a person's choice wins", () => {
    const i = idx([client("a", "Filmy Brands", "27AAPFU0939F1ZV"), client("b", "Else", null)]);
    expect(matchGroup(i, { groupKey: "g", name: "Filmy", gstin: "27AAPFU0939F1ZV" }, "b").decision).toMatchObject({ action: "match", clientId: "b", by: "user" });
    expect(matchGroup(i, { groupKey: "g", name: "Filmy", gstin: "27AAPFU0939F1ZV" }, "new").decision).toMatchObject({ action: "create", by: "user" });
  });
});

describe("T-13 plan hash", () => {
  it("is stable, and moves with one total, one client choice or the live series", () => {
    const h = plan(WORKED).planHash;
    expect(plan(WORKED).planHash).toBe(h);
    expect(plan(WORKED.replace('"47,200.00"', '"47,201.00"')).planHash).not.toBe(h);
    expect(plan(WORKED, { choices: { "gstin:06AAXFH1234K1Z3": "c-filmy" } }).planHash).not.toBe(h);
    expect(plan(WORKED, { ctx: { sequences: { "invoice:2026-27": 5, "invoice@06AAKCD3352K1ZJ:2026-27": 60 } } }).planHash).not.toBe(h);
  });
  it("lists every invoice key for the duplicate query", () => {
    const src = readSource(Buffer.from(WORKED), "s.csv", null, 100);
    const m = autoMap(src.rows[2], src.rows.slice(3), OWN).mapping;
    expect(extractKeys({ grid: src.rows, headerRow: 3, mapping: m, options: importOptionsSchema.parse({}), clientChoices: {} }).sort()).toEqual(["INV/24-25/0102", "INV/26-27/0012", "INV/26-27/059"]);
  });
});
