import { describe, it, expect } from "vitest";
import { buildLinkSearchWorkbook, buildEntityDuplicateRows } from "../src/services/link-search-export.service";
import type { LinkSearchResult } from "../src/services/link-search.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require("xlsx-js-style");

function makeResult(): LinkSearchResult {
  return {
    entity: { id: "e1", canonicalName: "Salman Khan", type: "PERSON", aliases: ["bhai"] },
    totalPosts: 3,
    uniquePosts: 2,
    duplicatePosts: 1,
    channelCount: 2,
    channels: [
      { accountId: "a1", handle: "paps1", displayName: "Paps One", platform: "instagram", postCount: 2 },
      { accountId: "a2", handle: "fbpage", displayName: "FB Page", platform: "facebook", postCount: 1 },
    ],
    posts: [
      // Ravi & Sana BOTH posted ig:AAA (different igsh tokens) → a cross-employee dupe.
      // Sana's submit (Jun 19 20:00 IST) is earlier in absolute time than Ravi's (Jun 20 10:00 IST).
      { canonicalKey: "ig:AAA", url: "https://instagram.com/reel/AAA/", platform: "instagram", account: { id: "a1", handle: "paps1", displayName: "Paps One" }, employee: { id: "u1", name: "Ravi" }, date: "2026-06-20", firstSeenAt: "2026-06-20T04:30:00.000Z", dupCount: 2 },
      { canonicalKey: "ig:AAA", url: "https://instagram.com/reel/AAA/?igsh=x", platform: "instagram", account: { id: "a1", handle: "paps1", displayName: "Paps One" }, employee: { id: "u2", name: "Sana" }, date: "2026-06-19", firstSeenAt: "2026-06-19T14:30:00.000Z", dupCount: 2 },
      // fb:123 only Ravi → NOT a cross-employee dupe.
      { canonicalKey: "fb:123", url: "https://facebook.com/reel/123", platform: "facebook", account: { id: "a2", handle: "fbpage", displayName: "FB Page" }, employee: { id: "u1", name: "Ravi" }, date: "2026-06-18", firstSeenAt: "2026-06-18T04:30:00.000Z", dupCount: 1 },
    ],
    coverage: {
      enriched: 100, notYetEnriched: 0, total: 100,
      searchable: 100, pendingExtraction: 0, nameSearchable: 100, unsearchable: 0, submitted: 200,
      byPlatform: {},
    },
  };
}

describe("buildLinkSearchWorkbook", () => {
  it("produces a valid three-sheet xlsx Buffer (Posts + Cross-Employee Duplicates + About)", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Posts", "Cross-Employee Duplicates", "About"]);
  });

  it("writes EVERY submitted link as its own row (same-vs-unique preserved — 3 posts, not 2)", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    const wb = XLSX.read(buf, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Posts"]);
    expect(rows.length).toBe(3); // all 3 submitted links, NOT collapsed to 2 unique
    // The two ig:AAA rows are flagged Duplicate; the fb:123 row is not.
    const dupFlags = rows.map((r: any) => r["Duplicate?"]);
    expect(dupFlags.filter((d: string) => d === "Yes").length).toBe(2);
  });

  it("carries submitted-by, channel, platform, and date columns", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    const wb = XLSX.read(buf, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Posts"]) as any[];
    const sample = rows.find((r) => r["Link URL"]?.includes("facebook"));
    expect(sample["Submitted By"]).toBe("Ravi");
    expect(sample["Channel"]).toBe("FB Page");
    expect(sample["Platform"]).toBe("facebook");
    expect(sample["Date"]).toBe("2026-06-18");
  });

  it("Cross-Employee Duplicates sheet lists only the ≥2-employee posts, with name + time", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    const wb = XLSX.read(buf, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Cross-Employee Duplicates"]) as any[];
    // Only the ig:AAA group (Ravi + Sana). fb:123 (Ravi only) is excluded.
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r["Dup Group"] === 1)).toBe(true);
    expect(rows.every((r) => r["Employees Sharing"] === 2)).toBe(true);
    // Earliest submit first: Sana (Jun 19 20:00 IST) before Ravi (Jun 20 10:00 IST).
    expect(rows.map((r) => r["Submitted By"])).toEqual(["Sana", "Ravi"]);
    expect(rows[0]["Posting Time (IST)"]).toBe("20:00");
    expect(rows[1]["Posting Time (IST)"]).toBe("10:00");
    // No fb:123 (single-employee) row leaked in.
    expect(rows.some((r) => String(r["Link URL"]).includes("facebook"))).toBe(false);
  });

  it("About sheet states the searched entity and honest coverage totals", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    const wb = XLSX.read(buf, { type: "buffer" });
    const about = XLSX.utils.sheet_to_json(wb.Sheets["About"], { header: 1 }) as string[][];
    const flat = about.flat().join(" | ");
    expect(flat).toContain("Salman Khan");
    expect(flat).toContain("100"); // nameSearchable
    expect(flat).toContain("200"); // submitted
    expect(flat.toLowerCase()).toContain("fetch-by-id"); // the coverage caveat
  });
});

describe("buildEntityDuplicateRows", () => {
  const post = (over: Partial<LinkSearchResult["posts"][number]>): LinkSearchResult["posts"][number] => ({
    canonicalKey: "ig:AAA",
    url: "https://instagram.com/reel/AAA/",
    platform: "instagram",
    account: { id: "a1", handle: "paps1", displayName: "Paps One" },
    employee: { id: "u1", name: "Ravi" },
    date: "2026-06-20",
    firstSeenAt: "2026-06-20T04:30:00.000Z",
    dupCount: 1,
    ...over,
  });

  it("requires ≥2 DISTINCT employees — one employee posting the same key twice is NOT a dupe", () => {
    const rows = buildEntityDuplicateRows([
      post({ employee: { id: "u1", name: "Ravi" }, firstSeenAt: "2026-06-20T04:30:00.000Z" }),
      post({ employee: { id: "u1", name: "Ravi" }, url: "https://instagram.com/reel/AAA/?igsh=z", firstSeenAt: "2026-06-21T04:30:00.000Z" }),
    ]);
    expect(rows.length).toBe(0);
  });

  it("groups the same post across different employees via canonicalKey (igsh token ignored)", () => {
    const rows = buildEntityDuplicateRows([
      post({ employee: { id: "u1", name: "Ravi" }, url: "https://instagram.com/reel/AAA/?igsh=a" }),
      post({ employee: { id: "u2", name: "Sana" }, url: "https://instagram.com/reel/AAA/?igsh=b" }),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0].employeesOnLink).toBe(2);
  });

  it("orders groups by most employees first, then numbers them 1..N", () => {
    const rows = buildEntityDuplicateRows([
      // group X: 2 employees
      post({ canonicalKey: "ig:X", employee: { id: "u1", name: "A" } }),
      post({ canonicalKey: "ig:X", employee: { id: "u2", name: "B" } }),
      // group Y: 3 employees → should be group 1 (more shared)
      post({ canonicalKey: "ig:Y", employee: { id: "u1", name: "A" } }),
      post({ canonicalKey: "ig:Y", employee: { id: "u2", name: "B" } }),
      post({ canonicalKey: "ig:Y", employee: { id: "u3", name: "C" } }),
    ]);
    const g1 = rows.filter((r) => r.groupNo === 1);
    expect(g1[0].employeesOnLink).toBe(3); // the 3-employee group ranks first
  });
});
