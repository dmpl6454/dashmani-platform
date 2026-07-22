import { describe, it, expect } from "vitest";
import { csvCell, toCsvLine, CSV_HEADERS, type CsvLinkRow } from "../src/services/report-links-csv.service";

describe("csvCell — RFC-4180 escaping", () => {
  it("leaves plain values unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
  });
  it("renders null/undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("quotes and doubles quotes when the value has a comma/quote/newline", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("neutralizes spreadsheet formula injection (leading = + - @)", () => {
    // A crafted URL/name beginning with =+-@ would otherwise execute as a formula.
    expect(csvCell("=1+2")).toBe("'=1+2"); // prefixed with ' (no comma → not wrapped)
    expect(csvCell("+1234")).toBe("'+1234");
    expect(csvCell("@handle")).toBe("'@handle");
    expect(csvCell("-5")).toBe("'-5");
    // Prefix AND quote when the formula also contains a comma.
    expect(csvCell("=SUM(A1,A2)")).toBe(`"'=SUM(A1,A2)"`);
    // A normal URL / value (interior '=' only) is untouched.
    expect(csvCell("https://x.com/=weird")).toBe("https://x.com/=weird");
  });
});

describe("toCsvLine — one DB link row → one CSV line", () => {
  // IST = UTC+5:30. 04:30Z → 10:00 IST; report date 2026-06-01.
  const row: CsvLinkRow = {
    url: "https://www.instagram.com/reel/ABC/?igsh=x",
    platform: "instagram",
    firstSeenAt: new Date("2026-06-01T04:30:00.000Z"),
    likes: 12,
    comments: 3,
    views: null,
    account: { displayName: "Bollywood Society", handle: "bollywoodsocietyy", platform: { name: "Instagram" } },
    report: { date: new Date("2026-06-01T00:00:00.000Z"), submittedAt: new Date("2026-06-01T16:31:00.000Z"), employee: { name: "Kajal yadav" } },
  };

  it("emits the columns in header order with IST date + time, trailing CRLF", () => {
    const line = toCsvLine(row);
    expect(line.endsWith("\r\n")).toBe(true);
    const cells = line.trimEnd().split(",");
    expect(cells.length).toBe(CSV_HEADERS.length);
    expect(cells[0]).toBe("2026-06-01"); // Date (IST)
    expect(cells[1]).toBe("10:00"); // Posting Time (IST)
    expect(cells[2]).toBe("Bollywood Society"); // Channel
    expect(cells[3]).toBe("bollywoodsocietyy"); // Handle
    expect(cells[4]).toBe("Instagram"); // Platform (title-cased)
    expect(cells[5]).toBe("Kajal yadav"); // Submitted By
    expect(cells[6]).toBe("https://www.instagram.com/reel/ABC/?igsh=x"); // Link URL (literal)
    expect(cells[7]).toBe("12"); // Likes
    expect(cells[8]).toBe("3"); // Comments
    expect(cells[9]).toBe(""); // Views (null → blank)
  });

  it("blanks a missing account/employee rather than printing 'null'", () => {
    const line = toCsvLine({ ...row, account: null, report: { ...row.report, employee: null } });
    const cells = line.trimEnd().split(",");
    expect(cells[2]).toBe(""); // Channel
    expect(cells[3]).toBe(""); // Handle
    expect(cells[4]).toBe("Instagram"); // falls back to the row's platform column
    expect(cells[5]).toBe(""); // Submitted By
  });

  it("falls back to the row platform column when the account has none", () => {
    const line = toCsvLine({ ...row, account: { displayName: "X", handle: "x", platform: null } });
    expect(line.trimEnd().split(",")[4]).toBe("Instagram");
  });

  it("quotes a URL / name that contains a comma so columns never shift", () => {
    const line = toCsvLine({ ...row, report: { ...row.report, employee: { name: "Doe, John" } } });
    // The quoted name keeps the column count stable under a naive split? No — a
    // naive comma-split breaks on the quoted comma, but the QUOTING is what a real
    // CSV parser relies on. Assert the quoted form is present.
    expect(line).toContain('"Doe, John"');
  });
});
