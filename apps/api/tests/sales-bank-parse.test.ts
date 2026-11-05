/**
 * Bank statement reader (spec-bank §4.1–4.2, tests §8.1) — pure: Buffer in, report out. No DB
 * (the global setup still truncates around each test). Red-green cases are marked (R→G).
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import type { BankMapping } from "@dashmani/shared";
import { applyMapping, checkAccount, dedupeHashes, detectDateOrder, detectMapping, extractUtr, headerSignature, parseAmount, parseDay, readGrid, type ParsedLine } from "../src/services/sales/bank-parse";

const OPTS = { today: "2026-11-05", accountNumber: "88452818788", matchFrom: null };
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n"));
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code; } };

describe("parseAmount", () => {
  it("reads the §4.1 table and the currency forms", () => {
    expect(parseAmount("1,23,456.78")).toEqual({ paise: 12_345_678n, sign: 1 });
    expect(parseAmount("1,000.00 Cr")).toEqual({ paise: 100_000n, sign: 1 });
    expect(parseAmount("500.00Dr")).toEqual({ paise: 50_000n, sign: -1 });
    expect(parseAmount("(1,000.00)")).toEqual({ paise: 100_000n, sign: -1 });
    expect(parseAmount("12.345")).toBe("error");
    expect(parseAmount("1234.5")).toEqual({ paise: 123_450n, sign: 1 });
    expect(parseAmount("₹ 2,500")).toEqual({ paise: 250_000n, sign: 1 });
    expect(parseAmount("INR 10.5")).toEqual({ paise: 1_050n, sign: 1 });
    expect(parseAmount("Rs. 5,000.5")).toEqual({ paise: 500_050n, sign: 1 });
    for (const blank of ["-", "NA", "0.00", "", "--", "0"]) expect(parseAmount(blank)).toBeNull();
    expect(parseAmount("1,23,456.00(Cr)")).toEqual({ paise: 12_345_600n, sign: 1 });
    expect(parseAmount("abc")).toBe("error");
  });
});

describe("parseDay", () => {
  it("reads every common bank date form as day/month/year", () => {
    for (const v of ["05/11/2026", "05-11-26", "05.11.2026", "5 Nov 2026", "05-Nov-2026", "05-NOV-26", "5 November 2026", "2026-11-05", "05/11/2026 10:42:11", "46331"]) {
      expect(parseDay(v, "dmy"), v).toBe("2026-11-05");
    }
    expect(parseDay("5 Sept 2026", "dmy")).toBe("2026-09-05");
    expect(parseDay("31/02/2026", "dmy")).toBeNull();
    expect(parseDay("11/25/2026", "mdy")).toBe("2026-11-25");
  });

  it("a day before 2015 or after tomorrow is a row error", () => {
    const rows = [["Date", "Narration", "Debit", "Credit", "Balance"], ["31/12/2014", "OLD", "", "100.00", ""], ["07/11/2026", "FUTURE", "", "100.00", ""], ["05/11/2026", "OK", "", "100.00", ""]];
    const m = detectMapping(rows)!.mapping;
    const rep = applyMapping(rows, m, OPTS);
    expect(rep.errors.map((e) => e.rowNo)).toEqual([2, 3]);
    expect(rep.lines).toHaveLength(1);
  });
});

describe("date order over a column", () => {
  it("a first part > 12 → dmy; a second part > 12 → mdy with a warning; ambiguous needs a choice (R→G)", () => {
    expect(detectDateOrder(["13/01/2026", "02/01/2026"])).toEqual({ order: "dmy", needs: false, warning: null });
    expect(detectDateOrder(["11/25/2026"]).order).toBe("mdy");
    expect(detectDateOrder(["11/25/2026"]).warning).toContain("month/day/year");
    expect(detectDateOrder(["01/02/2026", "02/02/2026", "03/02/2026"])).toEqual({ order: "dmy", needs: false, warning: null });
    // dmy reads 1 Feb, 2 Jan, 2 Mar (out of order); mdy reads 2 Jan, 1 Feb, 2 Mar (in order).
    expect(detectDateOrder(["01/02/2026", "02/01/2026", "03/02/2026"]).needs).toBe(true);
  });
});

const HDFC_PREAMBLE: string[][] = [
  ["HDFC BANK Ltd."], ["Page No .: 1"], ["Account No : 88452818788"], ["*****"], ...Array.from({ length: 16 }, (_, i) => [`Address line ${i}`]),
];
const presets: Record<string, string[][]> = {
  hdfc: [...HDFC_PREAMBLE, ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"], ["05/11/26", "NEFT CR-FILMY", "0000", "05/11/26", "", "1,000.00", "5,000.00"]],
  icici: [["Value Date", "Transaction Date", "Cheque Number", "Transaction Remarks", "Withdrawal Amount (INR )", "Deposit Amount (INR )", "Balance (INR )"], ["05/11/2026", "05/11/2026", "", "NEFT", "", "1000", "5000"]],
  sbi: [["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"], ["5 Nov 2026", "5 Nov 2026", "NEFT", "", "", "1,000.00", "5,000.00"]],
  axis: [["Tran Date", "CHQNO", "PARTICULARS", "DR", "CR", "BAL"], ["05-11-2026", "", "NEFT", "", "1000.00", "5000.00"]],
  kotak: [["Transaction Date", "Value Date", "Description", "Chq / Ref No.", "Amount", "Dr / Cr", "Balance"], ["05-11-2026", "05-11-2026", "NEFT", "", "1000.00", "CR", "5000.00"]],
  idfc: [["Transaction Date", "Value Date", "Particulars", "Cheque No", "Debit", "Credit", "Balance"], ["05-Nov-2026", "05-Nov-2026", "NEFT", "", "", "1000.00", "5000.00"]],
  yes: [["Transaction Date", "Value Date", "Cheque No/Reference No", "Description", "Withdrawals", "Deposits", "Running Balance"], ["05/11/2026", "05/11/2026", "", "NEFT", "", "1000.00", "5000.00"]],
};

describe("header detection", () => {
  it("finds the heading row and roles for every preset layout", () => {
    const hdfc = detectMapping(presets.hdfc)!;
    expect(hdfc.mapping.headerRow).toBe(21);
    expect(hdfc.preset).toBe("hdfc");
    expect(hdfc.mapping.columns).toMatchObject({ date: 0, narration: 1, reference: 2, valueDate: 3, debit: 4, credit: 5, balance: 6 });
    const icici = detectMapping(presets.icici)!;
    expect(icici.mapping.columns).toMatchObject({ date: 1, valueDate: 0, narration: 3, debit: 4, credit: 5, balance: 6 });
    expect(icici.preset).toBe("icici");
    expect(detectMapping(presets.sbi)!.preset).toBe("sbi");
    expect(detectMapping(presets.axis)!.mapping.columns).toMatchObject({ date: 0, narration: 2, debit: 3, credit: 4, balance: 5 });
    const kotak = detectMapping(presets.kotak)!;
    expect(kotak.mapping.amountStyle).toBe("drcr_column");
    expect(kotak.mapping.columns).toMatchObject({ amount: 4, drCr: 5 });
    expect(detectMapping(presets.idfc)!.preset).toBe("idfc");
    expect(detectMapping(presets.yes)!.mapping.columns).toMatchObject({ debit: 4, credit: 5, balance: 6 });
    for (const [name, rows] of Object.entries(presets)) {
      const rep = applyMapping(rows, detectMapping(rows)!.mapping, OPTS);
      expect(rep.lines, name).toHaveLength(1);
      expect(rep.lines[0].creditPaise, name).toBe(100_000n);
    }
    expect(applyMapping(presets.hdfc, detectMapping(presets.hdfc)!.mapping, OPTS).accountCheck.status).toBe("match");
  });

  it("no headings in the first 40 rows → null", () => {
    expect(detectMapping(Array.from({ length: 50 }, (_, i) => [`row ${i}`, "x"]))).toBeNull();
  });

  it("a 'Type' column holding NEFT/UPI is not a Dr/Cr column (R→G)", () => {
    const rows = [["Date", "Narration", "Type", "Amount"], ["05/11/2026", "X", "NEFT", "100.00"], ["05/11/2026", "Y", "UPI", "-50.00"]];
    const d = detectMapping(rows)!;
    expect(d.mapping.columns.drCr).toBeNull();
    expect(d.needs).toContain("amountSign");
  });

  it("an amount with a Cr/Dr suffix in most rows → suffix style", () => {
    const rows = [["Date", "Narration", "Amount"], ["05/11/2026", "X", "100.00 Cr"], ["05/11/2026", "Y", "50.00 Dr"]];
    const d = detectMapping(rows)!;
    expect(d.mapping.amountStyle).toBe("suffix");
    const rep = applyMapping(rows, d.mapping, OPTS);
    expect(rep.lines.map((l) => [l.creditPaise, l.debitPaise])).toEqual([[10_000n, 0n], [0n, 5_000n]]);
  });

  it("headerSignature is stable across case and punctuation", () => {
    expect(headerSignature(["Chq./Ref.No.", "Deposit Amount (INR )"])).toBe(headerSignature(["chq ref no", "DEPOSIT AMOUNT"]));
    expect(headerSignature(["Date"])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("rows after the heading", () => {
  const rows = [
    ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
    ["", "Opening Balance", "", "", "4,000.00"],
    ["01/11/2026", "NEFT CR FILMY BRANDS", "", "1,000.00", "5,000.00"],
    ["", "PVT LTD HDFCN52026110512", "", "", ""],
    ["", "", "", "", ""],
    ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
    ["02/11/2026", "ATM WDL", "500.00", "", "4,500.00"],
    ["Total", "", "500.00", "1,000.00", ""],
    ["** End of statement **", "", "", "", ""],
    ["Closing Balance", "", "", "", "4,500.00"],
  ];
  it("skips opening/closing/total/repeated heading/blank/end rows and joins a continuation narration (R→G)", () => {
    const rep = applyMapping(rows, detectMapping(rows)!.mapping, OPTS);
    expect(rep.lines).toHaveLength(2);
    expect(rep.lines[0].narration).toBe("NEFT CR FILMY BRANDS PVT LTD HDFCN52026110512");
    expect(rep.lines[0].utr).toBe("HDFCN52026110512");
    expect(rep.skipped.map((s) => s.reason)).toEqual(["Opening Balance", "repeated heading", "Total", "** End of statement **", "Closing Balance"]);
    expect(rep.openingPaise).toBe(400_000n);
    expect(rep.closingPaise).toBe(450_000n);
    expect(rep.period).toEqual({ from: "2026-11-01", to: "2026-11-02" });
  });

  it("both debit and credit, an unreadable amount, a date with no amount → listed with row numbers", () => {
    const bad = [["Date", "Narration", "Debit", "Credit"], ["05/11/2026", "BOTH", "1.00", "2.00"], ["05/11/2026", "BAD", "", "12.345"], ["05/11/2026", "ZERO", "", ""], ["31/02/2026", "BADDATE", "", "5.00"]];
    const rep = applyMapping(bad, detectMapping(bad)!.mapping, OPTS);
    expect(rep.errors.map((e) => e.rowNo)).toEqual([2, 3, 5]);
    expect(rep.errors[1].message).toContain("12.345");
    expect(rep.skipped).toEqual([{ rowNo: 4, reason: "zero-amount row" }]);
    expect(rep.lines).toEqual([]);
  });
});

describe("running balance", () => {
  const asc = [["Date", "Narration", "Debit", "Credit", "Balance"], ["01/11/2026", "A", "", "100.00", "1,100.00"], ["02/11/2026", "B", "50.00", "", "1,050.00"], ["03/11/2026", "C", "", "25.00", "1,075.00"]];
  it("ascending and descending files check out; a removed row breaks at the right row (R→G)", () => {
    const m = detectMapping(asc)!.mapping;
    expect(applyMapping(asc, m, OPTS).balanceCheck).toEqual({ status: "ok", breaks: [] });
    const desc = [asc[0], asc[3], asc[2], asc[1]];
    const d = applyMapping(desc, m, OPTS);
    expect(d.balanceCheck.status).toBe("ok");
    expect(d.openingPaise).toBe(100_000n);
    expect(d.closingPaise).toBe(107_500n);
    const gap = applyMapping([asc[0], asc[1], asc[3]], m, OPTS);
    expect(gap.balanceCheck).toEqual({ status: "breaks", breaks: [{ rowNo: 3, expectedPaise: 112_500n, foundPaise: 107_500n }] });
  });
});

describe("account hint", () => {
  const withPre = (pre: string) => [[pre], ["Date", "Narration", "Debit", "Credit"], ["05/11/2026", "X", "", "1.00"]];
  it("full number → match; masked other last 4 → mismatch; none → not stated", () => {
    const run = (pre: string) => { const r = withPre(pre); return applyMapping(r, detectMapping(r)!.mapping, OPTS).accountCheck; };
    expect(run("Account No : 88452818788").status).toBe("match");
    expect(run("A/C No. XXXXXXX4421")).toEqual({ status: "mismatch", found: "XXXXXXX4421" });
    expect(run("A/C No. XXXXXXX8788").status).toBe("match");
    expect(run("Statement of account").status).toBe("not_stated");
    expect(checkAccount("123456789", "88452818788").status).toBe("mismatch");
  });
});

describe("extractUtr", () => {
  it("NEFT 16, RTGS 22, RRN 12; an IFSC is never a UTR; long narrations stay fast", () => {
    expect(extractUtr("NEFT CR-HDFC0000240-FILMY-HDFCN52026110512", null)).toBe("HDFCN52026110512");
    expect(extractUtr("RTGS/HDFCR52026110500012345/FILMY", null)).toBe("HDFCR52026110500012345");
    expect(extractUtr("UPI/CR/530912345678/RIYA", null)).toBe("530912345678");
    expect(extractUtr("NEFT CR-HDFC0000240-FILMY", null)).toBeNull();
    const t = Date.now();
    extractUtr("A-".repeat(10_000), null);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe("dedupeHashes", () => {
  const L = (o: Partial<ParsedLine>): ParsedLine => ({ rowNo: 1, txnDate: "2026-11-05", valueDate: null, narration: "NEFT X", reference: null, utr: null, creditPaise: 100n, debitPaise: 0n, balancePaise: 500n, ...o });
  it("same rows → same; reversed → same set; narration truncation ignored with a balance (R→G); identical rows stay two; other account differs", () => {
    const a = [L({ rowNo: 1 }), L({ rowNo: 2, creditPaise: 200n, balancePaise: 700n })];
    expect(dedupeHashes("acc", a)).toEqual(dedupeHashes("acc", a));
    expect(new Set(dedupeHashes("acc", [...a].reverse()))).toEqual(new Set(dedupeHashes("acc", a)));
    expect(dedupeHashes("acc", [L({ narration: "NEFT CR FILMY BRANDS PRIVATE LIMITED" })])).toEqual(dedupeHashes("acc", [L({ narration: "NEFT CR FILMY BR" })]));
    const twins = dedupeHashes("acc", [L({ balancePaise: null }), L({ balancePaise: null })]);
    expect(twins[0]).not.toBe(twins[1]);
    expect(dedupeHashes("other", a)).not.toEqual(dedupeHashes("acc", a));
  });
});

describe("readGrid (sniffing)", () => {
  it("a PDF → STATEMENT_PDF; random bytes → STATEMENT_FORMAT", () => {
    expect(code(() => readGrid(Buffer.from("%PDF-1.7 ..."), "a.pdf"))).toBe("STATEMENT_PDF");
    expect(code(() => readGrid(Buffer.from([0, 1, 2, 3, 0, 255, 0, 7, 0]), "a.csv"))).toBe("STATEMENT_FORMAT");
  });

  it("a CSV keeps 01/02/2026 as text and reads it as 1 February (R→G — why SheetJS is not used for CSV)", () => {
    const g = readGrid(csv([["Date", "Narration", "Debit", "Credit"], ["01/02/2026", "X", "", "10.00"]]), "a.csv");
    expect(g.format).toBe("csv");
    expect(g.rows[1][0]).toBe("01/02/2026");
    expect(parseDay(g.rows[1][0], "dmy")).toBe("2026-02-01");
  });

  it("UTF-16LE CSV, an HTML 'xls' and an XLSX all read", () => {
    const text = "Date\tNarration\tDebit\tCredit\r\n05/11/2026\tX\t\t10.00\r\n";
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(readGrid(u16, "a.xls").rows[1][3]).toBe("10.00");
    const html = Buffer.from("<html><body><table><tr><td>Date</td><td>Narration</td><td>Debit</td><td>Credit</td></tr><tr><td>05/11/2026</td><td>X</td><td></td><td>10.00</td></tr></table></body></html>");
    const h = readGrid(html, "a.xls");
    expect(h.format).toBe("html");
    expect(h.rows[1][0]).toBe("05/11/2026");
    const ws = XLSX.utils.aoa_to_sheet([["Date", "Narration", "Debit", "Credit"], ["05/11/2026", "X", null, 10.5]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    const x = readGrid(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "a.xlsx");
    expect(x.format).toBe("xlsx");
    expect(x.sheet).toBe("Statement");
    expect(applyMapping(x.rows, detectMapping(x.rows)!.mapping, OPTS).lines[0].creditPaise).toBe(1_050n);
  });

  it("20,001 transaction rows → STATEMENT_TOO_LONG", () => {
    const rows = [["Date", "Narration", "Debit", "Credit"], ...Array.from({ length: 20_001 }, () => ["05/11/2026", "X", "", "1.00"])];
    expect(code(() => applyMapping(rows, detectMapping(rows)!.mapping as BankMapping, OPTS))).toBe("STATEMENT_TOO_LONG");
  });
});
