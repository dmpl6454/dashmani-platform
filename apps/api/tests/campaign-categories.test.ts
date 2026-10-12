import { describe, it, expect } from "vitest";
import { categoryKey, categoryTabs, inCategory, UNCATEGORISED_LABEL } from "@dashmani/shared/src/campaign/categories";

// Pure helpers behind the client's category tabs on the account picker. Pure, so no DB and no
// route: the catalogue route is covered in campaign.test.ts.

describe("categoryKey", () => {
  it("treats case, surrounding space and repeated inner space as the same category", () => {
    expect(categoryKey("Bollywood news")).toBe("bollywood news");
    expect(categoryKey("  bollywood   NEWS ")).toBe("bollywood news");
  });

  it("maps a blank or missing category to the empty key", () => {
    expect(categoryKey(null)).toBe("");
    expect(categoryKey(undefined)).toBe("");
    expect(categoryKey("   ")).toBe("");
  });
});

describe("categoryTabs", () => {
  it("counts accounts per category, most accounts first, with uncategorised accounts last", () => {
    const tabs = categoryTabs([
      { category: "Lifestyle" },
      { category: null },
      { category: "Bollywood" },
      { category: "Bollywood" },
      { category: "" },
    ]);
    expect(tabs).toEqual([
      { key: "bollywood", label: "Bollywood", count: 2 },
      { key: "lifestyle", label: "Lifestyle", count: 1 },
      { key: "", label: UNCATEGORISED_LABEL, count: 2 },
    ]);
  });

  it("merges spellings of one category into one tab, labelled with the most common spelling", () => {
    const tabs = categoryTabs([
      { category: "Bollywood news" },
      { category: "bollywood  NEWS" },
      { category: "Bollywood News" },
      { category: "Bollywood news" },
    ]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({ key: "bollywood news", label: "Bollywood news", count: 4 });
  });

  it("breaks a spelling tie deterministically (alphabetically first)", () => {
    const tabs = categoryTabs([{ category: "zeta NEWS" }, { category: "Zeta news" }]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.label).toBe("Zeta news");
  });

  it("returns no tabs for no accounts", () => {
    expect(categoryTabs([])).toEqual([]);
  });
});

describe("inCategory", () => {
  const rows = [
    { name: "a", category: "Bollywood" },
    { name: "b", category: "bollywood " },
    { name: "c", category: "Lifestyle" },
    { name: "d", category: null },
  ];

  it("keeps every row when no category is chosen", () => {
    expect(inCategory(rows, null)).toHaveLength(4);
  });

  it("keeps the rows of the chosen category, across spellings", () => {
    expect(inCategory(rows, "bollywood").map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("selects the uncategorised rows with the empty key", () => {
    expect(inCategory(rows, "").map((r) => r.name)).toEqual(["d"]);
  });

  it("returns nothing for a category that no row has", () => {
    expect(inCategory(rows, "sport")).toEqual([]);
  });
});
