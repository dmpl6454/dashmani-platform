/**
 * Smart invoicing PR 0 (spec-00 §2.7, §2.8): the shared TDS rules and toSafeNumber. Pure — no
 * database, no HTTP (the global setup file still truncates around each test).
 */
import { describe, it, expect } from "vitest";
import { classifyTds, nearestRate, panOf, sectionForRate, tdsAt, TDS_RATES, TDS_SECTIONS, TDS_TOLERANCE_PAISE } from "@dashmani/shared";
import { toSafeNumber } from "../src/services/sales/common";

describe("TDS constants", () => {
  it("are the one shared source", () => {
    expect(TDS_SECTIONS).toEqual(["194C", "194J", "194H", "other"]);
    expect(TDS_TOLERANCE_PAISE).toBe(100);
    expect(TDS_RATES.map((r) => [r.rateBp, r.kind, r.section])).toEqual([[100, "p1", "194C"], [200, "p2", "194C"], [1000, "p10", "194J"]]);
  });
});

describe("tdsAt / nearestRate / sectionForRate", () => {
  it("rounds to the paisa", () => {
    expect(tdsAt(10_000_000, 200)).toBe(200_000);
    expect(tdsAt(12_345, 100)).toBe(123);
    expect(tdsAt(12_355, 100)).toBe(124);
  });

  it("finds the closest rate within ±₹1, a tie going to the lower rate", () => {
    expect(nearestRate(200_000, 10_000_000)).toBe(200);
    expect(nearestRate(200_090, 10_000_000)).toBe(200);
    expect(nearestRate(200_101, 10_000_000)).toBeNull();
    expect(nearestRate(1_000_090, 10_000_000)).toBe(1000);
    // base 5 000 paise: 1% = 50, 2% = 100 — 75 is 25 from both: the lower rate wins.
    expect(nearestRate(75, 5_000)).toBe(100);
    // closest first: 1% = 100, 2% = 200; 160 is within ₹1 of both, nearer 2%.
    expect(nearestRate(160, 10_000)).toBe(200);
    expect(nearestRate(500, 10_000, [500])).toBe(500);
    expect(nearestRate(150, 10_000, [100], 10)).toBeNull();
  });

  it("maps a rate to its section", () => {
    expect(sectionForRate(100)).toBe("194C");
    expect(sectionForRate(200)).toBe("194C");
    expect(sectionForRate(1000)).toBe("194J");
    expect(sectionForRate(500)).toBeNull();
    expect(sectionForRate(null)).toBeNull();
  });
});

describe("classifyTds — spec-accounts §4.5", () => {
  const taxable = 10_000_000;
  const total = 11_800_000;
  it("the worked examples", () => {
    expect(classifyTds(1_000_000, taxable, total)).toEqual({ kind: "p10", label: "10% (194J)", rateBp: 1000, section: "194J" });
    expect(classifyTds(200_000, taxable, total)).toEqual({ kind: "p2", label: "2% (194C, or 194J technical)", rateBp: 200, section: "194C" });
    expect(classifyTds(200_000, taxable, total, "ABCPX1234Y")).toMatchObject({ kind: "p2", label: "2% (194C, or 194J technical) · a 194C deduction by an individual/HUF is 1%" });
    expect(classifyTds(200_000, taxable, total, "ABCHX1234Y").label).toContain("individual/HUF");
    expect(classifyTds(200_000, taxable, total, "ABCCX1234Y").label).toBe("2% (194C, or 194J technical)");
    expect(classifyTds(100_000, taxable, total)).toEqual({ kind: "p1", label: "1% (194C)", rateBp: 100, section: "194C" });
    expect(classifyTds(236_000, taxable, total)).toEqual({ kind: "on_total", label: "2% on the total incl. GST — should be on ₹1,00,000", rateBp: 236, section: "194C" });
    expect(classifyTds(275_000, taxable, total)).toEqual({ kind: "other", label: "2.75% of taxable", rateBp: 275, section: null });
    expect(classifyTds(1_000_090, taxable, total).kind).toBe("p10");
  });

  it("on the total with paise, and a zero taxable value", () => {
    expect(classifyTds(1_180, 100_050, 118_059).label).toBe("1% on the total incl. GST — should be on ₹1,000.50");
    expect(classifyTds(5_000, 0, 0)).toEqual({ kind: "other", label: "0.00% of taxable", rateBp: 0, section: null });
  });
});

describe("panOf", () => {
  it("prefers the profile PAN, else the GSTIN's characters 3–12", () => {
    expect(panOf(" aakcd3352k ", "27AAKCD3352K1ZF")).toEqual({ pan: "AAKCD3352K", source: "profile" });
    expect(panOf(null, "27aakcd3352k1zf")).toEqual({ pan: "AAKCD3352K", source: "gstin" });
    expect(panOf("", "")).toEqual({ pan: null, source: null });
    expect(panOf(null, null)).toEqual({ pan: null, source: null });
  });
});

describe("toSafeNumber", () => {
  it("reads BIGINTs and refuses anything past 2^53", () => {
    expect(toSafeNumber(12_345n)).toBe(12_345);
    expect(toSafeNumber(-7)).toBe(-7);
    expect(toSafeNumber(null)).toBe(0);
    expect(toSafeNumber(undefined)).toBe(0);
    expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "filed revenue")).toThrow("[sales] filed revenue out of safe range");
    expect(() => toSafeNumber(1.5)).toThrow("[sales] amount out of safe range");
  });
});
