/**
 * JSON replacer that lets Express serialise Prisma `BigInt` columns.
 *
 * ⚠️ WHY THIS EXISTS — a production outage. PR #164 (2026-09-22) added `total_views` and
 * `recent_views` as `BigInt?` on `social_accounts`. Prisma hands those back as JS `BigInt`,
 * and `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on one.
 * `GET /v1/accounts` returns raw Prisma rows, so from the first sync that wrote a non-null
 * value (~07:42Z on deploy day) every call 500'd, and the internal portal rendered that
 * failure as "No accounts found" / "No accounts assigned" on every tab — for 486 live
 * accounts. Nobody hit the page for a day, so nothing caught it. The previous last 200 was
 * 21 Sep 11:01Z.
 *
 * Only the accounts board was hit — the HR channel dropdown, report endpoints and
 * per-employee assignments use explicit selects without these columns (verified live) —
 * but the schema holds TWENTY BigInt columns across social_accounts, growth snapshots,
 * meta_assets and meta_asset_daily, and any future endpoint that returns one of those rows
 * raw would fail the same way. Fixing it at `res.json()` closes the whole class rather than
 * one call site.
 *
 * ⚠️ Numbers, not strings, and only when exact. Every consumer already treats these as
 * numbers (`num()` in channel-growth, `fmtMetric` in the portal), so a string would break
 * them. The largest value in the estate is ~5.9e12 (Facebook watch time in ms) against a
 * safe-integer ceiling of ~9.0e15, so `Number()` is lossless today; a value beyond that
 * ceiling is emitted as a string rather than silently rounded, so precision can never be
 * lost without it being visible in the payload.
 */
export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value.toString();
}
