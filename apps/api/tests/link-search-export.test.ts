import { describe, it, expect } from "vitest";
import { buildLinkSearchWorkbook } from "../src/services/link-search-export.service";
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
      { canonicalKey: "ig:AAA", url: "https://instagram.com/reel/AAA/", platform: "instagram", account: { id: "a1", handle: "paps1", displayName: "Paps One" }, employee: { id: "u1", name: "Ravi" }, date: "2026-06-20", dupCount: 2 },
      { canonicalKey: "ig:AAA", url: "https://instagram.com/reel/AAA/?igsh=x", platform: "instagram", account: { id: "a1", handle: "paps1", displayName: "Paps One" }, employee: { id: "u2", name: "Sana" }, date: "2026-06-19", dupCount: 2 },
      { canonicalKey: "fb:123", url: "https://facebook.com/reel/123", platform: "facebook", account: { id: "a2", handle: "fbpage", displayName: "FB Page" }, employee: { id: "u1", name: "Ravi" }, date: "2026-06-18", dupCount: 1 },
    ],
    coverage: {
      enriched: 100, notYetEnriched: 0, total: 100,
      searchable: 100, pendingExtraction: 0, nameSearchable: 100, unsearchable: 0, submitted: 200,
      byPlatform: {},
    },
  };
}

describe("buildLinkSearchWorkbook", () => {
  it("produces a valid two-sheet xlsx Buffer (Posts + About)", () => {
    const buf = buildLinkSearchWorkbook(makeResult(), "salman", new Date("2026-06-27T00:00:00Z"));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Posts", "About"]);
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
