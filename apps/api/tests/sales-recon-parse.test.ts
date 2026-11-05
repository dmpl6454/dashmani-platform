/**
 * Reconcile parsers (spec-reconcile §4, §10.1 P-1…P-22) — pure: bytes/text in, a report out.
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { normaliseDocNumber, normaliseLegalName } from "@dashmani/shared";
import { govPaise, jsonPaise, parseGovDay, sniffRecon } from "../src/services/sales/recon/read";
import { detect26asDelimiter, parse26asText, parseTdsSheet } from "../src/services/sales/recon/parse-26as";
import { parseGstr1Json, parseGstr1Sheets } from "../src/services/sales/recon/parse-gstr1";
import { readTdsFile, readGstr1File } from "../src/services/sales/recon/files";
import { parseDelimited, openWorkbook } from "../src/services/sales/tabular";
import { GSTR1_B2B_HEADERS, GSTR1_CDNR_HEADERS } from "../src/services/sales/accounts.service";
import { SAMPLE_26AS, gstr1OctoberJson } from "./recon-fixtures";

const xlsxOf = (sheets: Record<string, unknown[][]>) => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};

describe("Form 26AS text", () => {
  it("P-1 the §4.2 sample: header facts, 7 entries field by field, totals", () => {
    expect(detect26asDelimiter(SAMPLE_26AS)).toBe("^");
    const r = parse26asText(SAMPLE_26AS);
    expect(r.blockers).toEqual([]);
    expect(r.facts).toMatchObject({ pan: "AAKCD3352K", financialYear: "2025-26", assessmentYear: "2026-27", asOn: "2026-11-05", deductorCount: "6" });
    expect(r.items).toHaveLength(7);
    expect(r.items[0]).toEqual({ rowNo: 8, tan: "MUMF12345A", deductorName: "FILMY BRANDS PRIVATE LIMITED", section: "194J", txnDate: "2025-09-20", quarter: 2,
      bookingStatus: "F", bookingDate: "2025-10-30", remarks: null, amountPaidPaise: 10_000_000, tdsPaise: 1_000_000, depositedPaise: 1_000_000 });
    expect(r.items[2]).toMatchObject({ tan: "BLRK98765C", deductorName: "KANARA FOODS PVT. LTD.", section: "194C", quarter: 3, bookingStatus: "U", bookingDate: null, depositedPaise: 0 });
    expect(r.items.reduce((s, e) => s + e.amountPaidPaise, 0)).toBe(51_750_000);
    expect(r.items.reduce((s, e) => s + e.tdsPaise, 0)).toBe(3_175_000);
    expect(r.items.reduce((s, e) => s + (e.depositedPaise ?? 0), 0)).toBe(2_775_000);
    expect(r.warnings).toEqual([]);
  });

  it("P-2 PART-II and PART-VI rows are never read (no TCS 7th deductor)", () => {
    // A PART-VI (TCS) block laid out like Part I — heading and transaction rows — must not be read.
    const r = parse26asText(`${SAMPLE_26AS}\r\n^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Amount Paid / Credited(Rs.)^Tax Deducted##(Rs.)^TDS Deposited(Rs.)\r\n^1^206C^10-Oct-2025^F^-^-^10000.00^10.00^10.00`);
    expect(r.items.some((e) => e.tan === "MUMS00000A")).toBe(false);
    expect(new Set(r.items.map((e) => e.tan)).size).toBe(6);
  });

  it("P-3 a deductor's stated totals that differ from its lines → a warning naming both", () => {
    const r = parse26asText(SAMPLE_26AS.replace("1^FILMY BRANDS PRIVATE LIMITED^MUMF12345A^^^^^150000.00^15000.00", "1^FILMY BRANDS PRIVATE LIMITED^MUMF12345A^^^^^150000.00^16000.00"));
    expect(r.warnings.join("\n")).toContain("FILMY BRANDS PRIVATE LIMITED (MUMF12345A): lines add up to ₹1,50,000.00 / ₹15,000.00, 26AS says ₹1,50,000.00 / ₹16,000.00");
  });

  it("P-4 padding cells and reordered detail columns parse identically", () => {
    const reordered = SAMPLE_26AS.split("\r\n").map((l) => {
      if (l.startsWith("^Sr. No.^Section")) return "^^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks**^Tax Deducted##(Rs.)^Amount Paid / Credited(Rs.)^TDS Deposited(Rs.)^";
      if (/^\^\d+\^/.test(l)) { const c = l.split("^"); return ["", ...c.slice(0, 7), c[8], c[7], c[9], ""].join("^"); }
      return l;
    }).join("\r\n");
    const a = parse26asText(SAMPLE_26AS).items.map(({ rowNo: _r, ...x }) => x);
    const b = parse26asText(reordered).items.map(({ rowNo: _r, ...x }) => x);
    expect(b).toEqual(a);
  });

  it("P-5 No Transactions Present → warning; no Part I → TDS_NO_PART1; status X → null + warning; tab-delimited parses", () => {
    const none = parse26asText("File Creation Date^Permanent Account Number (PAN)\r\n05-11-2026^AAKCD3352K\r\n^PART-I - Details of Tax Deducted at Source^\r\n^No Transactions Present^\r\n");
    expect(none.items).toEqual([]);
    expect(none.warnings).toContain("Part I has no transactions.");
    expect(parse26asText("a^b\r\nc^d").blockers[0].code).toBe("TDS_NO_PART1");
    const x = parse26asText(SAMPLE_26AS.replace("^1^194J^05-Mar-2026^F^", "^1^194J^05-Mar-2026^X^"));
    expect(x.items.find((e) => e.tan === "DELR77777Z")!.bookingStatus).toBeNull();
    expect(x.warnings.some((w) => w.includes("'X' is not F, U, P or O"))).toBe(true);
    const tabbed = SAMPLE_26AS.replace(/\^/g, "\t");
    expect(detect26asDelimiter(tabbed)).toBe("\t");
    expect(parse26asText(tabbed, "\t").items).toEqual(parse26asText(SAMPLE_26AS).items);
  });

  it("P-6 parseGovDay: day-first only, real days, serials, and text cells", () => {
    for (const s of ["14-Oct-2026", "14-10-2026", "14/10/2026", "14.10.2026", "2026-10-14", "46309", "14-OCT-2026 00:00:00"]) expect(parseGovDay(s)).toBe("2026-10-14");
    expect(parseGovDay("5 Sept 2026")).toBe("2026-09-05");
    expect(parseGovDay("31-Feb-2026")).toBeNull();
    expect(parseGovDay("14/10/26")).toBeNull();
    expect(parseGovDay("")).toBeNull();
    expect(parseGovDay(parseDelimited("Date\n01/02/2026\n", 10).rows[1][0])).toBe("2026-02-01");
    const ws = XLSX.utils.aoa_to_sheet([["Date"], ["01/02/2026"]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "S");
    const g = openWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, 10).grid("S");
    expect(parseGovDay(g[1][0])).toBe("2026-02-01");
  });

  it("P-7 govPaise / jsonPaise", () => {
    expect(govPaise("100000.00")).toBe(10_000_000);
    expect(govPaise("1,00,000.00")).toBe(10_000_000);
    expect(govPaise("₹ 2,500")).toBe(250_000);
    expect(govPaise("Rs. 12.5")).toBe(1250);
    expect(govPaise("12.345")).toBe("error");
    expect(govPaise("-500")).toBe("error");
    for (const s of ["-", "NA", "N/A", ""]) expect(govPaise(s)).toBeNull();
    expect(jsonPaise(118000.5)).toBe(11_800_050);
    expect(jsonPaise(9000.000000001)).toBe(900_000);
    expect(jsonPaise(9000.005)).toBe("error");
    expect(jsonPaise(undefined)).toBe(0);
  });

  it("P-8 AIS CSV: TAN in parentheses, TDS- codes, SFT skipped, Inactive skipped, no deposited column, headings on row 3", () => {
    const csv = [
      "Annual Information Statement,,,,,",
      "PAN: AAKCD3352K,,,,,",
      "Information Code,Information Source,Transaction Date,Amount Paid/Credited,TDS Deducted,Status",
      "TDS-194J,FILMY BRANDS PRIVATE LIMITED (MUMF12345A),20/09/2025,100000.00,10000.00,Active",
      "SFT-005,SOME BANK (MUMS00000A),20/09/2025,500000.00,0,Active",
      "TDS-194J,FILMY BRANDS PRIVATE LIMITED (MUMF12345A),21/09/2025,1000.00,100.00,Inactive",
    ].join("\n");
    const r = parseTdsSheet(parseDelimited(csv, 100).rows);
    expect(r.format).toBe("ais_csv");
    expect(r.facts.pan).toBe("AAKCD3352K");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ tan: "MUMF12345A", deductorName: "FILMY BRANDS PRIVATE LIMITED", section: "194J", txnDate: "2025-09-20", bookingStatus: null, depositedPaise: null, tdsPaise: 1_000_000 });
    expect(r.facts.skippedRows).toBe("1");
    expect(r.warnings).toEqual(expect.arrayContaining(["1 SFT/TCS row skipped — only TDS is compared.", "1 inactive row skipped.", "AIS does not show whether the TDS was deposited."]));
  });

  it("P-9 a flattened 26AS CSV with Status of Booking → 26as_csv; no TDS column → RECON_FILE_UNREADABLE", () => {
    const csv = "TAN of Deductor,Name of Deductor,Section,Transaction Date,Status of Booking,Amount Paid / Credited,Tax Deducted,TDS Deposited\nMUMF12345A,FILMY,194J,20-Sep-2025,F,100000.00,10000.00,10000.00\n";
    const r = parseTdsSheet(parseDelimited(csv, 100).rows);
    expect(r.format).toBe("26as_csv");
    expect(r.items[0]).toMatchObject({ bookingStatus: "F", depositedPaise: 1_000_000 });
    const bad = parseTdsSheet(parseDelimited("TAN,Transaction Date,Amount Paid\nMUMF12345A,20-Sep-2025,1\n", 100).rows);
    expect(bad.blockers[0].code).toBe("RECON_FILE_UNREADABLE");
  });

  it("P-10 sniffRecon, and a UTF-16LE copy parses like the original", () => {
    expect(sniffRecon(Buffer.from("%PDF-1.4 x"))).toBe("pdf");
    expect(sniffRecon(xlsxOf({ S: [["a"]] }))).toBe("xlsx");
    expect(sniffRecon(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("26as.txt then bytes")]))).toBe("zip");
    expect(sniffRecon(Buffer.from('  {"gstin":"x"}'))).toBe("json");
    expect(sniffRecon(Buffer.from(SAMPLE_26AS))).toBe("text");
    expect(sniffRecon(Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]))).toBe("unknown");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE_26AS, "utf16le")]);
    const r = readTdsFile(utf16);
    expect(r.items).toEqual(parse26asText(SAMPLE_26AS).items);
  });

  it("P-11 two identical transaction lines → two entries with their own line numbers", () => {
    const dup = SAMPLE_26AS.replace("^1^194J^20-Sep-2025^F^30-Oct-2025^-^100000.00^10000.00^10000.00", "^1^194J^20-Sep-2025^F^30-Oct-2025^-^100000.00^10000.00^10000.00\r\n^1^194J^20-Sep-2025^F^30-Oct-2025^-^100000.00^10000.00^10000.00");
    const r = parse26asText(dup);
    const filmy = r.items.filter((e) => e.txnDate === "2025-09-20" && e.tan === "MUMF12345A");
    expect(filmy.map((e) => e.rowNo)).toEqual([8, 9]);
  });

  it("P-18 more than 20,000 entries → TOO_MANY_ROWS", () => {
    const head = SAMPLE_26AS.split("\r\n").slice(0, 7).join("\r\n");
    const line = "^1^194J^20-Sep-2025^F^30-Oct-2025^-^1.00^0.10^0.10";
    const r = parse26asText(`${head}\r\n${Array(20_001).fill(line).join("\r\n")}`);
    expect(r.blockers[0].code).toBe("TOO_MANY_ROWS");
  });
});

describe("GSTR-1", () => {
  it("P-12 the JSON: b2b heads summed over itms, rates, rowRef, pos, cdnr, return period, missing key = none filed", () => {
    const r = parseGstr1Json(gstr1OctoberJson());
    expect(r.gstin).toBe("27AAKCD3352K1ZF");
    expect(r.returnPeriod).toBe("102026");
    expect(r.sections).toEqual(["b2b", "cdnr", "b2cl", "b2cs", "exp", "cdnur"]);
    const d18 = r.items.find((d) => d.number === "INV/26-27/0018")!;
    expect(d18).toMatchObject({ section: "b2b", rowRef: "b2b[0].inv[1]", ctin: "27AABCU9603R1ZX", pos: "27", reverseCharge: false, valuePaise: 6_490_000, taxablePaise: 5_500_000, igstPaise: 0, cgstPaise: 495_000, sgstPaise: 495_000, cessPaise: 0, ratesBp: [1800], docDate: "2026-10-28", numberKey: "INV/26-27/18" });
    expect(r.items.find((d) => d.section === "cdnr")).toMatchObject({ number: "CN/26-27/0003", noteType: "C", igstPaise: 360_000 });
    const noCdnr = gstr1OctoberJson() as Record<string, unknown>;
    delete noCdnr.cdnr;
    const r2 = parseGstr1Json(noCdnr);
    expect(r2.sections).toContain("cdnr");
    expect(r2.items.filter((d) => d.section === "cdnr")).toEqual([]);
  });

  it("P-13 old CDNR layout, two-rate invoice, other sections as totals, amendments warned", () => {
    const j = {
      gstin: "27AAKCD3352K1ZF", fp: "102026",
      b2b: [{ ctin: "27AABCU9603R1ZX", inv: [{ inum: "A/1", idt: "01-10-2026", val: 1700, itms: [{ itm_det: { rt: 5, txval: 1000, camt: 25, samt: 25 } }, { itm_det: { rt: 18, txval: 500, camt: 45, samt: 45 } }] }] }],
      cdnr: [{ ctin: "27AABCU9603R1ZX", nt: [{ ntty: "C", nt_num: "CN/1", nt_dt: "05-10-2026", inum: "A/1", val: 100, itms: [{ itm_det: { rt: 18, txval: 85, camt: 7.5, samt: 7.5 } }] }] }],
      b2cs: [{ pos: "27", rt: 18, txval: 1000, camt: 90, samt: 90 }],
      b2cl: [{ pos: "29", inv: [{ inum: "B/1", idt: "02-10-2026", val: 300000, itms: [{ itm_det: { rt: 18, txval: 254237.29, iamt: 45762.71 } }] }] }],
      exp: [{ exp_typ: "WOPAY", inv: [{ inum: "E/1", idt: "03-10-2026", val: 5000, itms: [{ txval: 5000, rt: 0, iamt: 0 }] }] }],
      b2ba: [{ ctin: "x", inv: [{}, {}, {}] }],
    };
    const r = parseGstr1Json(j);
    expect(r.items.find((d) => d.number === "A/1")!.ratesBp).toEqual([500, 1800]);
    expect(r.items.find((d) => d.number === "CN/1")!.origNumber).toBe("A/1");
    expect(r.otherSections.b2cs).toMatchObject({ docs: 1, taxablePaise: 100_000, cgstPaise: 9_000 });
    expect(r.otherSections.b2cl).toMatchObject({ docs: 1, taxablePaise: 25_423_729 });
    expect(r.otherSections.exp).toMatchObject({ docs: 1, taxablePaise: 500_000 });
    expect(r.items.some((d) => d.number === "B/1" || d.number === "E/1")).toBe(false);
    expect(r.warnings[0]).toContain("3 amendments (B2BA)");
  });

  it("P-14 offline-template workbook: summary rows above headings, multi-row invoice grouped, differing value warned", () => {
    const b2b = [
      ["Summary For B2B(4)"], ["No. of Recipients", "", "No. of Invoices"], ["1", "", "1"],
      ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
      ["27AABCU9603R1ZX", "Filmy", "INV/26-27/0017", "22-Oct-2026", "1700", "27-Maharashtra", "N", "", "Regular B2B", "", "5", "1000", "0"],
      ["27AABCU9603R1ZX", "Filmy", "INV/26-27/0017", "22-Oct-2026", "1800", "27-Maharashtra", "N", "", "Regular B2B", "", "18", "500", "0"],
    ];
    const cdnr = [["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
      ["27AABCU9603R1ZX", "Filmy", "CN/1", "25-Oct-2026", "C", "27-Maharashtra", "N", "Regular B2B", "118", "", "18", "100", "0"]];
    const r = readGstr1File(xlsxOf({ "b2b,sez,de": b2b, cdnr, readme: [["x"]] }));
    expect(r.sections).toEqual(["b2b", "cdnr"]);
    const inv = r.items.find((d) => d.number === "INV/26-27/0017")!;
    expect(inv).toMatchObject({ valuePaise: 170_000, taxablePaise: 150_000, ratesBp: [500, 1800], rowRef: "b2b!5", pos: "27", invType: "R" });
    expect(r.warnings).toContain("INV/26-27/0017: the invoice value differs between its rows.");
  });

  it("P-15 a sheet without tax columns → taxColumns false, every tax field null", () => {
    const r = parseGstr1Sheets([{ name: "b2b", rows: [["Invoice Number", "Invoice date", "Invoice Value", "Rate", "Taxable Value", "GSTIN/UIN of Recipient"], ["A/1", "01-10-2026", "1180", "18", "1000", "27AABCU9603R1ZX"]] }], "xlsx");
    expect(r.taxColumns).toBe(false);
    expect(r.items[0]).toMatchObject({ igstPaise: null, cgstPaise: null, sgstPaise: null, taxablePaise: 100_000 });
  });

  it("P-16 a lone CSV takes its section from its headings", () => {
    expect(readGstr1File(Buffer.from("Note Number,Note Date,Note Value,Taxable Value,Rate\nCN/1,01-10-2026,118,100,18\n")).sections).toEqual(["cdnr"]);
    expect(readGstr1File(Buffer.from("Invoice Number,Invoice date,Invoice Value,Taxable Value,Rate\nA/1,01-10-2026,118,100,18\n")).sections).toEqual(["b2b"]);
  });

  it("P-17 invoice number 0016 stays 0016 in a CSV and an XLSX", () => {
    const csv = readGstr1File(Buffer.from("Invoice Number,Invoice date,Invoice Value,Taxable Value,Rate\n0016,01-10-2026,118,100,18\n"));
    expect(csv.items[0].number).toBe("0016");
    const x = readGstr1File(xlsxOf({ b2b: [["Invoice Number", "Invoice date", "Invoice Value", "Taxable Value", "Rate"], ["0016", "01-10-2026", "118", "100", "18"]] }));
    expect(x.items[0].number).toBe("0016");
  });

  it("P-19 accounts' GSTR1_B2B_HEADERS / GSTR1_CDNR_HEADERS map every role they carry", () => {
    const b2b = parseGstr1Sheets([{ name: "", rows: [[...GSTR1_B2B_HEADERS],
      ["27AABCU9603R1ZX", "Filmy Brands", "INV/26-27/0016", "14-Oct-2026", "1180.00", "27-Maharashtra", "N", "", "Regular B2B", "", "18", "1000.00", "0.00", "0.00", "90.00", "90.00"],
      ["29AAACB1234F1Z9", "Kanara", "INV/26-27/0017", "22-Oct-2026", "2360.00", "29-Karnataka", "N", "", "SEZ supplies without payment", "", "18", "2000.00", "0.00", "360.00", "0.00", "0.00"]] }], "csv");
    expect(b2b.sections).toEqual(["b2b"]);
    expect(b2b.items).toHaveLength(2);
    expect(b2b.items[0]).toMatchObject({ ctin: "27AABCU9603R1ZX", receiverName: "Filmy Brands", number: "INV/26-27/0016", docDate: "2026-10-14", valuePaise: 118_000, pos: "27", reverseCharge: false, invType: "R", ratesBp: [1800], taxablePaise: 100_000, cessPaise: 0, igstPaise: 0, cgstPaise: 9_000, sgstPaise: 9_000 });
    expect(b2b.items[1]).toMatchObject({ invType: "SEWOP", igstPaise: 36_000 });
    const cd = parseGstr1Sheets([{ name: "", rows: [[...GSTR1_CDNR_HEADERS], ["29AAACB1234F1Z9", "Kanara", "CN/26-27/0003", "30-Oct-2026", "C", "29-Karnataka", "N", "Regular B2B", "236.00", "", "18", "200.00", "0.00", "36.00", "0.00", "0.00"]] }], "csv");
    expect(cd.sections).toEqual(["cdnr"]);
    expect(cd.items[0]).toMatchObject({ number: "CN/26-27/0003", noteType: "C", valuePaise: 23_600, taxablePaise: 20_000, igstPaise: 3_600, invType: "R" });
  });

  it("P-22 a __proto__ key is inert", () => {
    const j = JSON.parse('{"gstin":"27AAKCD3352K1ZF","fp":"102026","__proto__":{"polluted":true},"b2b":[{"ctin":"27AABCU9603R1ZX","__proto__":{"polluted":true},"inv":[{"inum":"A/1","idt":"01-10-2026","val":118,"itms":[{"itm_det":{"rt":18,"txval":100,"camt":9,"samt":9}}]}]}]}');
    const r = parseGstr1Json(j);
    expect(r.items).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("normalisation", () => {
  it("P-20 normaliseDocNumber", () => {
    expect(normaliseDocNumber("inv/26-27/0016 ")).toEqual({ key0: "INV/26-27/0016", key1: "INV/26-27/16", key2: "INV262716" });
    expect(normaliseDocNumber("'INV/26-27/0016").key0).toBe("INV/26-27/0016");
    const a = normaliseDocNumber("INV/26-27/0016"), b = normaliseDocNumber("INV/26-27/016");
    expect(a.key1).toBe(b.key1);
    expect(a.key0).not.toBe(b.key0);
    expect(normaliseDocNumber("INV-26-27-16").key2).toBe(a.key2);
    const c = normaliseDocNumber("INV/26-27/0160");
    expect([c.key0 === b.key0, c.key1 === b.key1, c.key2 === b.key2]).toEqual([false, false, false]);
    expect(normaliseDocNumber("0000").key1).toBe("0");
  });

  it("P-21 normaliseLegalName", () => {
    expect(normaliseLegalName("Filmy Brands Pvt. Ltd.")).toBe(normaliseLegalName("FILMY BRANDS PRIVATE LIMITED"));
    expect(normaliseLegalName("FILMY BRANDS PRIVATE LIMITED")).toBe("FILMYBRANDS");
    expect(normaliseLegalName("M/s. Kanara Foods & Co")).toBe(normaliseLegalName("KANARA FOODS AND CO"));
    expect(normaliseLegalName("XYZ INDIA PRIVATE LIMITED")).not.toBe(normaliseLegalName("XYZ PRIVATE LIMITED"));
  });
});
