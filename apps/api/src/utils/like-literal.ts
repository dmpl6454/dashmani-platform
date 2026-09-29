/**
 * Make a string safe to use as a LITERAL inside a Prisma case-insensitive `equals`.
 *
 * ⚠️ Prisma (5.x, PostgreSQL) sends `{ equals: x, mode: "insensitive" }` as
 * `col ILIKE $1` and does NOT escape the value. So `%` matches any run of characters,
 * `_` matches any single character, and `\` escapes whatever follows it. With an
 * unescaped value, an identifier like `a_b@x.com` matches the stored `axb@x.com`, and
 * `%@x.com` matches every address on that domain. This was verified live against the
 * query log. Escaping all three (with `\`, which is Postgres' default LIKE escape
 * character) makes the pattern mean exactly "this string, ignoring case", and the
 * match is still case-insensitive.
 *
 * Use it at every `equals` + `mode: "insensitive"` lookup on user-supplied input, and
 * above all on auth paths. `contains` / `startsWith` / `endsWith` are no safer: Prisma
 * wraps the value as `%value%` and does not escape it either (also verified live), so
 * a search box that must match a literal `_` or `%` needs this helper too.
 *
 * Linear, no lookbehind. Callers must length-bound the input first.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
