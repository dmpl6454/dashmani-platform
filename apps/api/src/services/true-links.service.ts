// True Links / Cross-Employee Duplicates — the Reports page's dedupe-aware stats.
//
// WHAT: for a date window, computes (a) team totals — total submissions, TRUE links
// (distinct posts by canonicalKey), how many links ≥2 DIFFERENT employees posted
// (allowed, surfaced for visibility) — and (b) a per-employee breakdown (their
// submissions, distinct links, shared-with-others links, unique-to-them links)
// powering a sortable leaderboard.
//
// HOW (OOM-SAFE — the non-negotiable): ALL dedupe math runs inside Postgres in ONE
// query / ONE table scan (shared CTE + UNION ALL for the team row). Node receives
// ~1 row per employee plus one team row (~90 rows of small ints) — NEVER the link
// rows themselves. Loading 100k+ URLs into Node to dedupe in JS is the exact
// pattern that OOM'd the box twice (2026-07-08/09, 2026-07-16). Measured on prod
// at 90d/team scale (108k links): ~2.9s cold, one pool connection, ~7MB sort spill.
// A 60s TTL cache (the leaderboard.service.ts pattern) absorbs repeat views.
//
// ⚠️ THE DERIVED-KEY CASE MUST MIRROR canonicalKey() (@dashmani/shared). This is
// the FOURTH copy of the derived-key CASE in the codebase (the other three live in
// link-search.service.ts — two coverage CTEs + the search join). If canonicalKey()
// learns a new URL shape, update ALL FOUR. Two deliberate differences from the
// link-search copies, both required for DEDUPE correctness (they only need
// platform-recognized keys; dedupe needs a key for EVERY row):
//   1. ELSE 'raw:' || lower(url)  — canonicalKey()'s fallback is the lowercased
//      full URL (opaque FB /share/, unresolved Snapchat /t/, anything unrecognized
//      dedupes on exact-URL match, same as submit-time).
//   2. COALESCE(CASE…, raw fallback) — a URL that MATCHES a platform WHEN but whose
//      id capture fails (e.g. a too-short YouTube id) yields 'yt:' || NULL = NULL.
//      GROUP BY collapses all NULLs into ONE group, which would FABRICATE a phantom
//      cross-employee duplicate out of unrelated URLs. canonicalKey() falls through
//      to the raw fallback in that case, so the SQL must too. Locked by the
//      characterization test (true-links.test.ts) which asserts SQL output equals a
//      JS canonicalKey() run over the same seeded rows.
//
// ⚠️ Prisma $queryRaw tagged templates are COOKED — every backslash in the SQL
// regexes below is DOUBLED (\\.) so Postgres sees \. (see CLAUDE.md, PR #104's
// watch?v= regression). The date bounds are always concrete Dates (epoch /
// far-future when absent) so the template stays fully static — the repo's proven
// pattern; no conditional Prisma.sql fragments.
//
// Date semantics INTENTIONALLY match getReportSummary (gte/lte on new Date(str)).
// totalSubmissions counts LIVE links only (url IS NOT NULL AND is_scheduled=false —
// the set dedupe is defined over), while the Total Links card counts ALL link rows.
// The two are equal whenever the window has no scheduled/null-url rows (measured on
// prod 2026-07-22: 0 of each in 90d, so they currently reconcile exactly) — but a
// scheduled link would legitimately widen the card without widening this number,
// which is why the UI labels this figure "submitted" from ITS OWN response, never
// asserting equality with the card.

import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export interface TrueLinksEmployeeRow {
  id: string;
  name: string;
  /** Their link rows (submissions) in the window. */
  totalSubmissions: number;
  /** Their distinct posts (by canonicalKey) in the window. */
  distinctLinks: number;
  /** Distinct posts of theirs that ≥2 DIFFERENT employees posted (shared/dup). */
  sharedDupLinks: number;
  /** Distinct posts ONLY they posted (their true unique contribution). */
  trueUniqueLinks: number;
}

export interface TrueLinksBreakdown {
  /** Team link rows in the window — reconciles with the Total Links card. */
  totalSubmissions: number;
  /** Team distinct posts by canonicalKey — the "True Links" headline. */
  trueLinks: number;
  /** Distinct posts that ≥2 DIFFERENT employees posted. */
  crossEmployeeDupLinks: number;
  /** Total submissions landing on those shared posts. */
  crossEmployeeDupSubmissions: number;
  byEmployee: TrueLinksEmployeeRow[];
}

// ── 60s TTL cache with SINGLE-FLIGHT (extends the leaderboard.service.ts
// pattern) ───────────────────────────────────────────────────────────────────
// The cache stores the in-flight PROMISE, not just the resolved value, so N
// concurrent cold requests for the same window share ONE query instead of each
// taking a pool connection for the ~5s aggregation (the 10-conn pool on the
// 1-vCPU box is the scarce resource). A failed compute self-evicts immediately
// so an error is never served for 60s. Entry count is bounded (distinct custom
// windows could otherwise grow it without limit). Tests MUST reset this in
// beforeEach (the documented cross-test cache-pollution class) — see
// invalidateTrueLinksCache.
const TRUE_LINKS_TTL_MS = 60 * 1000;
const TRUE_LINKS_CACHE_MAX = 100;
const _tlCache = new Map<string, { promise: Promise<TrueLinksBreakdown>; builtAt: number }>();
export function invalidateTrueLinksCache(): void {
  _tlCache.clear();
}

interface RawRow {
  kind: "emp" | "team";
  id: string | null;
  name: string | null;
  c1: number; // emp: totalSubmissions | team: totalSubmissions
  c2: number; // emp: distinctLinks    | team: trueLinks
  c3: number; // emp: sharedDupLinks   | team: crossEmployeeDupLinks
  c4: number; // emp: trueUniqueLinks  | team: crossEmployeeDupSubmissions
}

export async function getTrueLinksBreakdown(
  startDate?: string,
  endDate?: string,
): Promise<TrueLinksBreakdown> {
  const cacheKey = `${startDate ?? ""}:${endDate ?? ""}`;
  const nowMs = Date.now();
  const hit = _tlCache.get(cacheKey);
  if (hit && nowMs - hit.builtAt < TRUE_LINKS_TTL_MS) return hit.promise;

  // Bound the entry count: sweep expired entries when the map grows; hard-clear
  // as a last resort (worst case = one extra cold query, never unbounded memory).
  if (_tlCache.size >= TRUE_LINKS_CACHE_MAX) {
    for (const [k, v] of _tlCache) {
      if (nowMs - v.builtAt >= TRUE_LINKS_TTL_MS) _tlCache.delete(k);
    }
    if (_tlCache.size >= TRUE_LINKS_CACHE_MAX) _tlCache.clear();
  }

  const promise = computeTrueLinksBreakdown(startDate, endDate);
  _tlCache.set(cacheKey, { promise, builtAt: nowMs });
  // Never cache a failure for the TTL — evict so the next request retries. (The
  // .catch is on a DERIVED promise: callers awaiting the original still receive
  // the rejection; this just prevents an unhandled-rejection warning + poisoning.)
  promise.catch(() => {
    const cur = _tlCache.get(cacheKey);
    if (cur && cur.promise === promise) _tlCache.delete(cacheKey);
  });
  return promise;
}

async function computeTrueLinksBreakdown(
  startDate?: string,
  endDate?: string,
): Promise<TrueLinksBreakdown> {
  // Concrete bounds always (static template — see header). Same gte/lte semantics
  // as getReportSummary so the numbers reconcile with the on-screen cards.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");
  // A garbage date string parses to Invalid Date, which Prisma cannot bind — that
  // would surface as an opaque 500. Reject it as the clean 400 it actually is.
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, "VALIDATION_ERROR", "startDate/endDate must be valid dates");
  }

  const rows = await prisma.$queryRaw<RawRow[]>`
    WITH keyed AS (
      SELECT
        r.employee_id,
        COALESCE(
          CASE
            -- Every WHEN/capture is HOST-ANCHORED ('^https?://(?:[^/?#]*\\.)?host/')
            -- to mirror JS's parsed-hostname validation. Unanchored substring
            -- matching keyed EMBEDDED urls the arbiter treats as raw — e.g. a
            -- redirect wrapper '...l.php?u=https://youtube.com/watch?v=<id>' or
            -- the PR #108 glued-FB rows ('...reel/<id>https://...') — which could
            -- fabricate a duplicate the submit-time arbiter denies (adversarial
            -- review 2026-07-22; 2 real glued rows existed in 109k prod urls).
            -- ⚠️ The host-prefix group MUST be non-capturing (?:...) — substring()
            -- returns the FIRST parenthesized group, which must stay the id.
            --
            -- YouTube: JS validates EXACTLY 11 chars as a complete segment/param
            -- (isValidVideoId) — hence {11} + a terminal boundary ([/?#], [&#] or
            -- end). Without it, 'youtu.be/abcdef?si=1' and '?si=2' (invalid short
            -- ids JS treats as DISTINCT raw urls) would merge into one phantom key.
            -- (?i) director: the ~* WHEN is case-insensitive but substring() is
            -- case-SENSITIVE by default — without (?i) a mixed-case host/segment
            -- would match the WHEN yet fail the capture. Captures preserve source
            -- case (ids stay case-sensitive, per canonicalKey's guarantees).
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?youtu\\.be/[A-Za-z0-9_-]{11}([/?#]|$)'
              THEN 'yt:' || substring(rl.url from '(?i)^https?://(?:[^/?#]*\\.)?youtu\\.be/([A-Za-z0-9_-]{11})([/?#]|$)')
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?youtube\\.com/[^[:space:]]*[?&]v=[A-Za-z0-9_-]{11}([&#]|$)'
              THEN 'yt:' || substring(rl.url from '(?i)[?&]v=([A-Za-z0-9_-]{11})([&#]|$)')
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?youtube\\.com/(shorts|embed|live|e)/[A-Za-z0-9_-]{11}([/?#]|$)'
              THEN 'yt:' || substring(rl.url from '(?i)^https?://(?:[^/?#]*\\.)?youtube\\.com/(?:shorts|embed|live|e)/([A-Za-z0-9_-]{11})([/?#]|$)')
            -- Instagram: JS captures pathname [^/]+ (ANY chars to the next slash,
            -- not just [A-Za-z0-9_-]) — on a raw url that's [^/?#]+ (stop at query/
            -- fragment too). The optional prefix segment must also be [^/?#]+ so it
            -- can never swallow a '?' and key a non-path lookalike.
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?instagram\\.com/([^/?#]+/)?(p|reel|reels|tv)/[^/?#]'
              THEN 'ig:' || substring(rl.url from '(?i)^https?://(?:[^/?#]*\\.)?instagram\\.com/(?:[^/?#]+/)?(?:p|reel|reels|tv)/([^/?#]+)')
            -- Facebook ?v=: JS requires the ENTIRE param to be digits (/^\\d+$/) —
            -- 'v=123x' must FALL THROUGH to the path branch (as JS does), so the
            -- WHEN itself demands the full-digits+boundary form.
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?(facebook\\.com|fb\\.watch)/[^[:space:]]*[?&]v=[0-9]+([&#]|$)'
              THEN 'fb:' || substring(rl.url from '(?i)[?&]v=([0-9]+)([&#]|$)')
            -- Facebook path: JS requires digits to be TERMINAL ((\\d+)(?:\\/|$) on
            -- the pathname) — 'reel/123' + apostrophe/suffix falls back to raw.
            -- THE live divergence this CASE originally had: /reel/<id>' (a paste
            -- typo) merged with the clean /reel/<id>/ and fabricated one phantom
            -- cross-employee dup on prod. fb.watch mirrors JS's host set.
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?(facebook\\.com|fb\\.watch)/(reel|videos|video)/[0-9]+([/?#]|$)'
              THEN 'fb:' || substring(rl.url from '(?i)^https?://(?:[^/?#]*\\.)?(?:facebook\\.com|fb\\.watch)/(?:reel|videos|video)/([0-9]+)([/?#]|$)')
            -- Snapchat: JS's /spotlight/ segment match is case-SENSITIVE (no i
            -- flag in extractSnapchatSpotlightId) — hence the second, case-
            -- sensitive ~ condition and a case-sensitive capture.
            WHEN rl.url ~* '^https?://([^/?#]*\\.)?snapchat\\.com/' AND rl.url ~ '/spotlight/[A-Za-z0-9_-]{8,}'
              THEN 'sc:' || substring(rl.url from '/spotlight/([A-Za-z0-9_-]{8,})')
            ELSE 'raw:' || lower(rl.url)
          END,
          'raw:' || lower(rl.url)
        ) AS ckey
      FROM report_links rl
      JOIN daily_reports r ON r.id = rl.report_id
      WHERE rl.url IS NOT NULL
        AND rl.is_scheduled = false
        AND r.date >= ${start}
        AND r.date <= ${end}
    ),
    key_stats AS (
      SELECT ckey, COUNT(DISTINCT employee_id) AS emps, COUNT(*) AS subs
      FROM keyed
      GROUP BY ckey
    ),
    emp_keys AS (
      SELECT employee_id, ckey, COUNT(*) AS subs
      FROM keyed
      GROUP BY employee_id, ckey
    )
    SELECT
      'emp' AS kind,
      e.employee_id AS id,
      u.name AS name,
      SUM(e.subs)::int AS c1,
      COUNT(*)::int AS c2,
      COUNT(*) FILTER (WHERE ks.emps >= 2)::int AS c3,
      COUNT(*) FILTER (WHERE ks.emps = 1)::int AS c4
    FROM emp_keys e
    JOIN key_stats ks ON ks.ckey = e.ckey
    JOIN users u ON u.id = e.employee_id
    GROUP BY e.employee_id, u.name
    UNION ALL
    SELECT
      'team',
      NULL,
      NULL,
      COALESCE(SUM(subs), 0)::int,
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE emps >= 2)::int,
      COALESCE(SUM(subs) FILTER (WHERE emps >= 2), 0)::int
    FROM key_stats
  `;

  const byEmployee: TrueLinksEmployeeRow[] = [];
  let team: TrueLinksBreakdown = {
    totalSubmissions: 0,
    trueLinks: 0,
    crossEmployeeDupLinks: 0,
    crossEmployeeDupSubmissions: 0,
    byEmployee,
  };
  for (const r of rows) {
    if (r.kind === "team") {
      team = {
        totalSubmissions: r.c1,
        trueLinks: r.c2,
        crossEmployeeDupLinks: r.c3,
        crossEmployeeDupSubmissions: r.c4,
        byEmployee,
      };
    } else if (r.id) {
      byEmployee.push({
        id: r.id,
        name: r.name ?? "",
        totalSubmissions: r.c1,
        distinctLinks: r.c2,
        sharedDupLinks: r.c3,
        trueUniqueLinks: r.c4,
      });
    }
  }
  // Deterministic default order: most shared-duplicate links first (the question the
  // panel exists to answer), then most true-unique, then name. The frontend re-sorts
  // client-side, so this only sets the initial view.
  byEmployee.sort(
    (a, b) =>
      b.sharedDupLinks - a.sharedDupLinks ||
      b.trueUniqueLinks - a.trueUniqueLinks ||
      a.name.localeCompare(b.name),
  );

  return team;
}
