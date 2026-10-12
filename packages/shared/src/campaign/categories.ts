/**
 * Account categories on the campaign account picker ("Bollywood news", "Lifestyle"…).
 *
 * Staff type a category on the rate card of each page or account; a blank one means the account
 * is not categorised yet. Matching ignores case and spacing, so "Bollywood news" and
 * "bollywood  NEWS " are one tab, labelled with the spelling most accounts use.
 *
 * Pure: imported by the client portal and tested in apps/api. Import it by module path, never
 * through the @dashmani/shared barrel (that pulls every validator into the client bundle).
 */

export const UNCATEGORISED_LABEL = "Uncategorised";

/** Trim, collapse inner spaces, lower-case. Blank or missing → "" (the uncategorised key). */
export function categoryKey(raw: string | null | undefined): string {
  return spaced(raw).toLowerCase();
}

function spaced(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

export interface CategoryTab {
  /** categoryKey() of the category; "" for uncategorised accounts. */
  key: string;
  label: string;
  count: number;
}

/**
 * One tab per category among the rows, most accounts first, uncategorised last. The label is the
 * spelling used most often for that category (ties: alphabetically first) so the tab reads like
 * the staff entry, not like the lower-cased key.
 */
export function categoryTabs(rows: ReadonlyArray<{ category: string | null }>): CategoryTab[] {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const r of rows) {
    const key = categoryKey(r.category);
    const group = groups.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    group.count += 1;
    const spelled = spaced(r.category);
    if (spelled) group.spellings.set(spelled, (group.spellings.get(spelled) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: key === "" ? UNCATEGORISED_LABEL : mostUsedSpelling(group.spellings),
      count: group.count,
    }))
    .sort(
      (a, b) =>
        Number(a.key === "") - Number(b.key === "") ||
        b.count - a.count ||
        a.label.localeCompare(b.label),
    );
}

function mostUsedSpelling(spellings: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount || (count === bestCount && spelling < best)) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

/** The rows in one category. `key` null = no category filter (every row). */
export function inCategory<T extends { category: string | null }>(rows: T[], key: string | null): T[] {
  if (key === null) return rows;
  return rows.filter((r) => categoryKey(r.category) === key);
}
