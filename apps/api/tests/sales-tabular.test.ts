/**
 * Smart invoicing PR 0 (spec-00 §2.5, §2.8): the shared tabular reader and the CSV writers.
 * Pure — no database, no HTTP (the global setup file still truncates around each test).
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { decodeText, excelSerialToDay, openWorkbook, parseDelimited, ROW_HEADROOM, sniffFormat, TabularError } from "../src/services/sales/tabular";
import { csvDocument, csvField, csvMoney } from "../src/services/sales/csv";

const workbook = (rows: unknown[][], fmt: Record<string, string> = {}, bookType: XLSX.BookType = "xlsx") => {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  for (const [addr, z] of Object.entries(fmt)) (ws[addr] as XLSX.CellObject).z = z;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sales");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
};

describe("sniffFormat", () => {
  it("knows each format by its bytes, not its name", () => {
    expect(sniffFormat(Buffer.from("%PDF-1.7\n…"))).toBe("pdf");
    expect(sniffFormat(workbook([["a"]]))).toBe("xlsx");
    expect(sniffFormat(workbook([["a"]], {}, "biff8"))).toBe("xls");
    expect(sniffFormat(Buffer.from("﻿  \r\n<html><body><TABLE><tr><td>x</td></tr></TABLE></body></html>"))).toBe("html");
    expect(sniffFormat(Buffer.from("<html><body>no table here</body></html>"))).toBe("csv");
    expect(sniffFormat(Buffer.from("Date,Amount\n05/11/2026,100\n"))).toBe("csv");
    expect(sniffFormat(Buffer.from([0x41, 0x00, 0x42, 0x00]))).toBe("unknown");
    expect(sniffFormat(Buffer.alloc(0))).toBe("unknown");
  });

  it("reads a UTF-16 text file as csv (Excel's \"Unicode text\")", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date\tAmount\r\n05-11-2026\t100\r\n", "utf16le")]);
    expect(sniffFormat(le)).toBe("csv");
  });
});

describe("decodeText", () => {
  it("follows the BOM and strips it", () => {
    expect(decodeText(Buffer.from("﻿No,₹"))).toBe("No,₹");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Café", "utf16le")]))).toBe("Café");
    const be = Buffer.from("Café", "utf16le");
    be.swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe("Café");
  });

  it("is strict UTF-8, falling back to windows-1252", () => {
    expect(decodeText(Buffer.from("Rs ₹1,000 — ok"))).toBe("Rs ₹1,000 — ok");
    // 0x80 = € and 0x93/0x94 = curly quotes in windows-1252; 0xE9 = é. Not valid UTF-8.
    expect(decodeText(Buffer.from([0x80, 0x20, 0x93, 0x41, 0x94, 0x20, 0x43, 0x61, 0x66, 0xe9]))).toBe("€ “A” Café");
  });
});

describe("parseDelimited", () => {
  it("keeps every cell as text and handles RFC 4180 quoting", () => {
    const { delimiter, rows } = parseDelimited('Invoice No,Party,Amount\r\nINV/26-27/0016,"Filmy, Brands",0016\n"multi\nline","He said ""hi""",-200.00\n', 100);
    expect(delimiter).toBe(",");
    expect(rows).toEqual([
      ["Invoice No", "Party", "Amount"],
      ["INV/26-27/0016", "Filmy, Brands", "0016"],
      ["multi\nline", 'He said "hi"', "-200.00"],
    ]);
  });

  it("picks the delimiter that is consistent across lines; ties go , ; \\t |", () => {
    expect(parseDelimited("a;b;c\n1;2,5;3\n4;5;6", 10).delimiter).toBe(";");
    expect(parseDelimited("a\tb\n1\t2\n", 10)).toEqual({ delimiter: "\t", rows: [["a", "b"], ["1", "2"]] });
    expect(parseDelimited("a|b|c\n1|2|3\n", 10).delimiter).toBe("|");
    expect(parseDelimited("a,b;c\n1,2;3\n", 10).delimiter).toBe(",");
    expect(parseDelimited("just one column\nno delimiters", 10).delimiter).toBe(",");
    // A delimiter inside quotes does not count.
    expect(parseDelimited('"a;b",c\n"1;2",3\n', 10).delimiter).toBe(",");
  });

  it("strips a BOM, keeps blank lines, drops trailing empty rows and columns", () => {
    expect(parseDelimited("﻿a,b,\n\n1,2,\n,,\n\n", 10).rows).toEqual([["a", "b"], [""], ["1", "2"]]);
  });

  it("stops after maxRows + ROW_HEADROOM rows, so an over-long file is detectable", () => {
    const text = Array.from({ length: 200 }, (_, i) => `${i},x`).join("\n");
    expect(parseDelimited(text, 10).rows).toHaveLength(10 + ROW_HEADROOM);
  });

  it("is linear time on a hostile input (no regex over the text)", () => {
    const evil = `"${"a,".repeat(400_000)}`; // an unterminated quote over ~800 KB
    const t = Date.now();
    const { rows } = parseDelimited(evil, 10);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(rows).toHaveLength(1);
  });
});

describe("excelSerialToDay", () => {
  it("is calendar arithmetic, no time zone", () => {
    expect(excelSerialToDay(46331)).toBe("2026-11-05");
    expect(excelSerialToDay(46331.99)).toBe("2026-11-05");
    expect(excelSerialToDay(45383)).toBe("2024-04-01");
    expect(excelSerialToDay(0)).toBeNull();
    expect(excelSerialToDay(Number.NaN)).toBeNull();
  });
});

describe("openWorkbook", () => {
  const rows = [
    ["Sales Report", null, null, null],
    ["Invoice No", "Date", "Amount", "Paid"],
    ["INV/26-27/0016", 46331, 1234.5, true],
    ["  INV/26-27/0017 ", 46332, 0.1 + 0.2, false],
    [null, null, null, null],
  ];

  for (const bookType of ["xlsx", "biff8"] as const) {
    it(`turns every ${bookType} cell into text: dates as days, numbers without float noise`, () => {
      const wb = openWorkbook(workbook(rows, { B3: "dd-mm-yyyy", B4: "d/m/yy", C3: "#,##0.00" }, bookType), 100);
      expect(wb.sheetNames).toEqual(["Sales"]);
      expect(wb.grid("Sales")).toEqual([
        ["Sales Report", "", "", ""],
        ["Invoice No", "Date", "Amount", "Paid"],
        ["INV/26-27/0016", "2026-11-05", "1234.5", "TRUE"],
        ["INV/26-27/0017", "2026-11-06", "0.3", "FALSE"],
      ]);
    });
  }

  it("keeps an HTML table's cells exactly as shown (no month-first date guess)", () => {
    const html = Buffer.from("<html><body><table><tr><td>Date</td><td>Amount</td></tr><tr><td>05/11/2026</td><td>1,234.50</td></tr></table></body></html>");
    const wb = openWorkbook(html, 100);
    expect(wb.grid(wb.sheetNames[0])).toEqual([["Date", "Amount"], ["05/11/2026", "1,234.50"]]);
  });

  it("reads at most maxRows + ROW_HEADROOM rows and maxCols columns", () => {
    const many = Array.from({ length: 120 }, (_, i) => [i, "x", "y"]);
    const wb = openWorkbook(workbook(many), 10);
    const g = wb.grid("Sales", 2);
    expect(g).toHaveLength(10 + ROW_HEADROOM);
    expect(g[0]).toEqual(["0", "x"]);
  });

  it("an unknown sheet is empty", () => {
    expect(openWorkbook(workbook([["a"]]), 10).grid("Nope")).toEqual([]);
  });

  it("refuses a password-protected file as encrypted, garbage as unreadable", () => {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, "/EncryptionInfo", Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]));
    XLSX.CFB.utils.cfb_add(cfb, "/EncryptedPackage", Buffer.alloc(64));
    const encrypted = Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Buffer);
    expect(sniffFormat(encrypted)).toBe("xls");
    try {
      openWorkbook(encrypted, 10);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TabularError);
      expect((e as TabularError).kind).toBe("encrypted");
    }
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)]);
    expect(() => openWorkbook(broken, 10)).toThrow(TabularError);
    try { openWorkbook(broken, 10); } catch (e) { expect((e as TabularError).kind).toBe("unreadable"); }
  });
});

describe("CSV writing", () => {
  it("csvMoney is exact integer arithmetic", () => {
    expect(csvMoney(-20_000)).toBe("-200.00");
    expect(csvMoney(0)).toBe("0.00");
    expect(csvMoney(5)).toBe("0.05");
    expect(csvMoney(-5)).toBe("-0.05");
    expect(csvMoney(123_456_789)).toBe("1234567.89");
    expect(csvMoney(900_719_925_474_099_123n)).toBe("9007199254740991.23");
    expect(() => csvMoney(1.5)).toThrow();
  });

  it("csvField writes numbers bare and guards every other string", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField(-7n)).toBe("-7");
    expect(csvField("-200.00")).toBe("-200.00");
    expect(csvField("0016")).toBe("0016");
    expect(csvField("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("-cmd")).toBe("'-cmd");
    expect(csvField("Filmy, Brands")).toBe('"Filmy, Brands"');
    expect(csvField(null)).toBe("");
    expect(csvField(Number.NaN)).toBe("");
  });

  it("csvDocument is BOM + comma + CRLF", () => {
    const buf = csvDocument([["Invoice", "Amount"], ["INV/26-27/0016", csvMoney(-20_000)]]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.subarray(3).toString("utf8")).toBe("Invoice,Amount\r\nINV/26-27/0016,-200.00\r\n");
  });
});
