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

  it("maps a category typed as the uncategorised label to the empty key", () => {
    expect(categoryKey("Uncategorised")).toBe("");
    expect(categoryKey("  uncategorised ")).toBe("");
    expect(categoryKey("Uncategorized")).toBe("");
  });

  it("drops zero-width characters pasted at either end of a category", () => {
    expect(categoryKey("Bollywood​")).toBe("bollywood");
    expect(categoryKey("​Bollywood‍")).toBe("bollywood");
    expect(categoryKey("﻿ Bollywood news ⁠")).toBe("bollywood news");
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

  it("labels a tab with the majority spelling even when it is first or last in the list", () => {
    expect(categoryTabs([{ category: "bollywood" }, { category: "Bollywood" }, { category: "Bollywood" }])[0]?.label).toBe("Bollywood");
    expect(categoryTabs([{ category: "Bollywood" }, { category: "Bollywood" }, { category: "bollywood" }])[0]?.label).toBe("Bollywood");
  });

  it("does not create a second tab for a category typed as the uncategorised label", () => {
    const tabs = categoryTabs([{ category: "Uncategorised" }, { category: null }, { category: "Lifestyle" }]);
    expect(tabs).toEqual([
      { key: "lifestyle", label: "Lifestyle", count: 1 },
      { key: "", label: UNCATEGORISED_LABEL, count: 2 },
    ]);
  });

  it("breaks a spelling tie in favour of fewer capitals", () => {
    const tabs = categoryTabs([{ category: "zeta NEWS" }, { category: "Zeta news" }]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.label).toBe("Zeta news");
  });

  it("prefers a title-cased spelling over an all-lowercase one on a tie", () => {
    expect(categoryTabs([{ category: "bollywood news" }, { category: "Bollywood news" }])[0]?.label).toBe("Bollywood news");
  });

  it("breaks a tie between equally capitalised spellings alphabetically", () => {
    // Both have two capitals (Z, A), so the alphabetical rule decides.
    expect(categoryTabs([{ category: "Zeta Ab" }, { category: "Zeta Aa" }])[0]?.label).toBe("Zeta Aa");
  });

  it("treats a decomposed accent and a precomposed one as the same category", () => {
    const tabs = categoryTabs([{ category: "Café" }, { category: "Café" }]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.count).toBe(2);
  });

  it("treats a category made only of zero-width characters as uncategorised", () => {
    expect(categoryKey("​")).toBe("");
    const tabs = categoryTabs([{ category: "​" }, { category: null }]);
    expect(tabs).toEqual([{ key: "", label: UNCATEGORISED_LABEL, count: 2 }]);
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
