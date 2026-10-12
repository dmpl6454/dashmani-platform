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
  const key = spaced(raw).toLowerCase();
  // A category typed as "Uncategorised" (or the US spelling) means the same as none: one tab, not two.
  return UNCATEGORISED_WORDS.has(key) ? "" : key;
}

const UNCATEGORISED_WORDS = new Set([UNCATEGORISED_LABEL.toLowerCase(), "uncategorized"]);

/**
 * Unicode-normalised (so a pasted accent in another encoding matches), with zero-width characters
 * dropped (pasted from a web page or a word processor, they are invisible), trimmed, inner spaces collapsed.
 */
function spaced(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").replace(/[​-‍⁠﻿]/g, "").trim().replace(/\s+/g, " ");
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

/** Most used wins; on a tie, a spelling that starts with a capital, then fewer capitals, then alphabetical. */
function mostUsedSpelling(spellings: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount || (count === bestCount && preferredSpelling(spelling, best))) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

/** Title-cased labels read best, so "Bollywood news" beats both "bollywood news" and "BOLLYWOOD NEWS". */
function preferredSpelling(a: string, b: string): boolean {
  const startsUpper = (s: string) => /^\p{Lu}/u.test(s);
  if (startsUpper(a) !== startsUpper(b)) return startsUpper(a);
  const caps = (s: string) => (s.match(/\p{Lu}/gu) ?? []).length;
  return caps(a) !== caps(b) ? caps(a) < caps(b) : a.localeCompare(b) < 0;
}

/** The rows in one category. `key` null = no category filter (every row). */
export function inCategory<T extends { category: string | null }>(rows: T[], key: string | null): T[] {
  if (key === null) return rows;
  return rows.filter((r) => categoryKey(r.category) === key);
}
