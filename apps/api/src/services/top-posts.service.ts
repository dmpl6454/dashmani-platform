/**
 * Top Posts — the best-performing links OUR EMPLOYEES SUBMITTED, for the /overview
 * command centre.
 *
 * This is the submitted-links counterpart to the Meta-owned "Latest Posts" card: where
 * that one lists what our connected channels published, this ranks what the team
 * actually put into daily reports, by how far it travelled.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO HONOUR ──────────────────────────────────────
 *
 * 1. ⚠️ IT READS `link_metrics_latest`, NEVER `link_metrics`. `link_metrics` is the
 *    append-only per-poll HISTORY — 14.6M rows / 10GB on prod as of 2026-09-18, and
 *    reading it on a portal path is the precise cause of that day's P2024 outage, when
 *    six "latest per link" scans held the whole 10-connection pool for minutes and the
 *    LOGIN PAGE started returning "An unexpected error occurred". `link_metrics_latest`
 *    holds ONE row per (employee, url) — 111k rows — and is the only sanctioned read
 *    path for submitted-link engagement.
 *
 * 2. ⚠️ IT IS ISOLATED FROM THE OVERVIEW PAYLOAD, DELIBERATELY. It is its own endpoint
 *    with its own memo, NOT another field on getOverview(). Two reasons, both load
 *    bearing: (a) the overview's cache key already carries five independent periods
 *    plus a custom range against a 60-entry map — adding 4 periods x 3 platforms would
 *    multiply that key space by 12 and thrash the map, serving one window's numbers
 *    under another's label, which is the exact failure its own comment warns about;
 *    (b) this query touches a DIFFERENT and heavier table than every other overview
 *    widget, so keeping it out of that Promise.all means a slow Top Posts can never
 *    delay the KPI strip. A card that is late is a card that is late. A dashboard that
 *    is late is an outage.
 *
 * 3. ⚠️ A METRIC META DOES NOT PUBLISH IS NULL, NEVER 0. Snapchat exposes no like
 *    count; Facebook's likes are absent on ~25% of rows. Every consumer must render a
 *    dash. This is the documented fabricated-zero class (the Snapchat showLikes
 *    incident), and a RANKING amplifies it from one wrong cell to a wrong order.
 *
 * ── ON RANKING INSTAGRAM BY VIEWS ───────────────────────────────────────────────────
 *
 * Until 2026-09-19 `instagram.provider.ts` hardcoded `views: null`, so 0 of 43,828
 * stored Instagram rows carried a view count and a views ranking would have collapsed
 * to the fetched_at tie-break — surfacing near-zero-engagement posts as "top viral".
 * That was never a Meta limitation: `insights.metric(views)` is a FREE inline expansion
 * on the media list (live-probed, 800/800 media at the production page size). The
 * provider now populates it, so Instagram ranks by real views like every other
 * platform. Rows polled before that change still carry null and are excluded by
 * `views IS NOT NULL` rather than ranked as zero — so the board fills in as the
 * 2-hourly sweep re-polls, and never lies in the meantime.
 */

import { prisma, Prisma } from "@dashmani/db";
import { dateToIST } from "@dashmani/shared";
import { DERIVED_CANONICAL_KEY_SQL } from "./true-links.service";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { withHeavyQuerySlot } from "../utils/heavy-query";

/**
 * Windows this card offers.
 *
 * ⚠️ 1 (24h) IS DELIBERATELY NOT IN `OVERVIEW_PERIODS`. The global period drives the
 * Meta channel widgets, whose day boundaries are Meta's (Facebook closes at PACIFIC
 * midnight, Instagram at UTC) and whose reach metric only exists for Meta's own
 * `week`/`days_28` windows — a 1-day global would hand every one of those cards a
 * window that is partly open and a baseline it cannot compare against. This widget has
 * no such problem: it filters `report_date`, an IST calendar day written by
 * `istMidnight(todayIST())` when an employee submits, which has nothing to do with
 * Meta's boundaries. So 24h is honest HERE and only here. Keep the two sets separate.
 */
export const TOP_POST_PERIODS = [1, 7, 30, 90] as const;
export type TopPostPeriod = (typeof TOP_POST_PERIODS)[number];

export const TOP_POST_PLATFORMS = ["all", "instagram", "facebook"] as const;
export type TopPostPlatform = (typeof TOP_POST_PLATFORMS)[number];

/** Hard cap on rows returned. The card shows 5; the expanded view shows the rest. */
const LIMIT = 20;

/**
 * How many grouped rows to pull before collapsing them by canonicalKey.
 *
 * ⚠️ WIDER THAN `LIMIT` ON PURPOSE. SQL groups on `url_normalized`, which is only
 * `url.toLowerCase()` — NOT `canonicalKey()`. So one post can arrive as several rows
 * (`/reel/123` vs `/reel/123/`, or two `?igsh=` tokens on the same Instagram reel), and
 * collapsing them is what makes "one post = one row" and "shared by N" true. Measured on
 * prod 2026-09-19: of 181 posts genuinely submitted by 2+ employees in 30 days, 174
 * (96%) were split this way — Instagram 18 of 18. Fetching 3x the rows we return leaves
 * room for that collapse without a second query; anything below the cut could only enter
 * the top 20 by merging, and a merge does not raise a group's MAX(views).
 */
const CANDIDATES = LIMIT * 3;

export interface TopPost {
  urlNormalized: string;
  url: string;
  platform: string;
  /** Null when Meta/the platform publishes no such number — render a dash, never 0. */
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** How many DISTINCT employees submitted this same post (1 = solo, >=2 = shared). */
  submitters: number;
  /** Most recent submission date in the window (IST calendar day, YYYY-MM-DD). */
  lastSubmitted: string;
  /**
   * When this post's engagement was last actually measured.
   *
   * ⚠️ A view count is as old as its poll, and the 2-hourly sweep is tiered — a link in
   * the older tier can go days between polls. Without this the card would say "the views
   * it has now" about a number from last week. The UI renders a staleness chip past 48h,
   * mirroring the per-row chip on the /reports Top Links panel.
   */
  measuredAt: string;
  /** First line of the caption, when we happen to hold the post. Null otherwise. */
  title: string | null;
  /** Meta CDN preview, ONLY if still within its own signed expiry. Null otherwise. */
  thumbnailUrl: string | null;
  /** The channel this went out on, when resolvable. */
  channel: string | null;
}

export interface TopPostsResult {
  platform: TopPostPlatform;
  days: TopPostPeriod;
  start: string;
  end: string;
  posts: TopPost[];
  /** Links in the window we could rank (have a view count) vs all links in it. */
  ranked: number;
  total: number;
  /** How many of the returned rows carry a usable preview — lets the UI be honest. */
  withPreview: number;
}

const TTL_MS = 60_000;
const _memo = createSingleFlightMemo({ ttlMs: TTL_MS, maxEntries: 40 });
/** ⚠️ MANDATORY in every touching test's beforeEach — the documented cross-test cache-pollution class. */
export function invalidateTopPostsCache(): void {
  _memo.clear();
}

// ─────────────────────────── pure helpers (unit-tested) ───────────────────────────

/**
 * Meta CDN URLs are SIGNED and carry their own expiry in the `oe=` parameter as a hex
 * unix timestamp — measured live on 2026-09-19 at ~4.4 days out.
 *
 * ⚠️ This is the whole reason a stored preview URL is safe to ship. A post only keeps a
 * fresh URL while it stays inside its asset's feed window (the ~3-hourly sync rewrites
 * it); once it falls out, the stored URL rots and would 403 in the browser. Checking
 * `oe` means we serve a URL we know is still valid or we serve NOTHING — so a missing
 * preview renders as the card's designed placeholder, and a BROKEN IMAGE never appears.
 *
 * Unparseable or already-expired ⇒ null. A URL with no `oe` at all is also refused:
 * every Meta CDN URL observed carries one, so its absence means this is not the kind of
 * URL we reasoned about and we should not gamble on it.
 */
export function thumbnailIfFresh(url: string | null | undefined, now: number): string | null {
  if (!url) return null;
  const m = /[?&]oe=([0-9A-Fa-f]+)/.exec(url);
  if (!m) return null;
  const expiresMs = parseInt(m[1], 16) * 1000;
  if (!Number.isFinite(expiresMs) || expiresMs <= now) return null;
  return url;
}

/**
 * Derive the id that `meta_posts.match_id` is keyed on, from a SUBMITTED link URL.
 *
 * ⚠️ BEST-EFFORT AND PRESENTATION-ONLY. This mirrors `deriveMatchId` in
 * meta-posts.service.ts, but unlike the four derived-key CASE expressions documented in
 * CLAUDE.md it is NOT an arbiter of anything: a miss costs one preview thumbnail and a
 * title, never a wrong count and never a wrong group. Ranking, de-duplication and every
 * number on the card come from `link_metrics_latest.url_normalized` alone and are
 * completely unaffected by what this returns. Do not "harden" it into a join key.
 */
export function matchIdFromUrl(platform: string, url: string): string | null {
  if (platform === "instagram") {
    const m = /instagram\.com\/(?:p|reel|reels|tv)\/([^/?#]+)/i.exec(url);
    return m ? m[1] : null;
  }
  if (platform === "facebook") {
    const m = /\/(?:reel|videos|posts|video)\/(\d{6,})/i.exec(url);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * ISO day, N days back from an ISO day, inclusive.
 *
 * ⚠️ BOTH ENDS ARE IST DAYS, never UTC ones. `report_date` is written by
 * `istMidnight(todayIST())` when an employee submits, so it is an IST calendar day. The
 * server runs in UTC (verified on prod: getTimezoneOffset() === 0), so deriving the end
 * from `new Date().toISOString()` would name YESTERDAY's IST day for the whole
 * 00:00–05:29 IST window — the exact class of bug the repo fixed platform-wide in
 * 2026-05-30 and again for HR drafts in PR #127. On a "Last 24 hours" board that is not
 * an off-by-a-bit: it drops every submission made so far today.
 */
function shiftIsoDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function firstLine(caption: string | null, max = 68): string | null {
  const line = (caption ?? "").split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ─────────────────────────────────── the read ───────────────────────────────────

interface RankedRow {
  ckey: string;
  url: string;
  platform: string;
  views: bigint | number | null;
  likes: bigint | number | null;
  comments: bigint | number | null;
  submitters: bigint | number;
  last_submitted: Date;
  measured_at: Date;
  /** Window-function totals over the whole grouped set — identical on every row. */
  total_groups: bigint | number;
  ranked_groups: bigint | number;
}

const num = (v: bigint | number | null | undefined): number | null =>
  v == null ? null : typeof v === "bigint" ? Number(v) : v;

export function getTopPosts(params: {
  platform: TopPostPlatform;
  days: TopPostPeriod;
  /** Test seam only — production always uses the real clock. */
  now?: Date;
}): Promise<TopPostsResult> {
  const key = `${params.platform}:${params.days}`;
  return _memo.memo(key, () => withHeavyQuerySlot("top-posts", () => build(params)));
}

async function build(params: {
  platform: TopPostPlatform;
  days: TopPostPeriod;
  now?: Date;
}): Promise<TopPostsResult> {
  const nowDate = params.now ?? new Date();
  const nowMs = nowDate.getTime();
  // ⚠️ IST days, because report_date is an IST day. See shiftIsoDay.
  const end = dateToIST(nowDate); // todayIST() with an injectable clock, for tests
  const start = shiftIsoDay(end, -(params.days - 1));

  // ⚠️ Parameterised, and the platform filter is a WHITELISTED enum value rather than
  // caller text — `Prisma.sql` keeps it bound either way, but the route also validates.
  const platformFilter =
    params.platform === "all" ? Prisma.sql`` : Prisma.sql`AND rl.platform = ${params.platform}`;

  // ⚠️ GROUPED ON THE CANONICAL KEY, NOT ON url_normalized.
  //
  // `link_metrics_latest.url_normalized` is only `url.toLowerCase()`, so ONE post
  // arrives as several rows whenever the raw urls differ — a trailing slash, or the
  // fresh `?igsh=` token Instagram mints on every copy. Measured on prod 2026-09-19: of
  // 181 posts genuinely submitted by 2+ employees in 30 days, 174 (96%) were split that
  // way, Instagram 18 of 18. Grouping on the lowercased url would therefore have listed
  // the same reel twice and reported "1 submitter" for a post three people shared.
  //
  // DERIVED_CANONICAL_KEY_SQL is the repo's ONE strict copy of canonicalKey() in SQL —
  // the same expression true-links.service.ts uses, locked by a test that compares it to
  // the JS arbiter and verified 100.0000% identical across all 109,765 prod URLs. It is
  // IMPORTED rather than copied precisely so this file cannot drift from it. It reads
  // `rl.url`, which is why the table is aliased `rl`.
  //
  // ⚠️ `HAVING MAX(rl.views) IS NOT NULL`, NOT `WHERE rl.views IS NOT NULL`. The WHERE
  // form selects the same GROUPS but drops individual ROWS first, so a post submitted by
  // three people of whom only one has been re-polled would report ONE submitter. That is
  // guaranteed during the Instagram views rollout, where rows refill a batch at a time.
  //
  // ⚠️ url and platform are taken with the SAME ordering, so they always describe one
  // real row — independent MIN()s could pair one variant's url with another's platform.
  // Highest-views-first means the row links to the copy whose number is on screen.
  //
  // ⚠️ COST, MEASURED END-TO-END ON PROD 2026-09-19: 24h 79ms, 7d 280ms, 30d (the
  // default) 1.16s, 90d (the worst) 4.21s. It was 3.3s / 7.0s when the denominators
  // were a SECOND statement that re-ran the whole derived-key CASE over the window —
  // folding them in as window functions is where that 40% went. The regex CASE is the
  // remaining bulk; grouping on the cheap lowercased url was 584ms at 90d, and that
  // speed is exactly what produced the wrong answer. Three things make the trade safe, and all
  // three must stay: the 60s single-flight memo (one compute per minute per
  // platform+window, never one per viewer), the 2-slot heavy-query bulkhead (analytics
  // can never drain the pool login and HR submit share), and this being its OWN endpoint
  // (a slow board delays one card, not the KPI strip). For scale, true-links.service.ts
  // runs the same expression over 108k rows at ~5s cold behind the same pattern.
  // If it ever needs to be faster, make the QUERY cheaper — do not raise the bulkhead.
  const rows = await prisma.$queryRaw<RankedRow[]>`
    WITH keyed AS (
      SELECT ${DERIVED_CANONICAL_KEY_SQL} AS ckey,
             rl.url, rl.platform, rl.views, rl.likes, rl.comments,
             rl.employee_id, rl.report_date, rl.fetched_at
      FROM link_metrics_latest rl
      WHERE rl.report_date >= ${start}::date
        AND rl.report_date <= ${end}::date
        ${platformFilter}
    ),
    grouped AS (
      SELECT k.ckey,
             (ARRAY_AGG(k.url      ORDER BY k.views DESC NULLS LAST, k.url))[1] AS url,
             (ARRAY_AGG(k.platform ORDER BY k.views DESC NULLS LAST, k.url))[1] AS platform,
             MAX(k.views)                     AS views,
             MAX(k.likes)                     AS likes,
             MAX(k.comments)                  AS comments,
             COUNT(DISTINCT k.employee_id)    AS submitters,
             MAX(k.report_date)               AS last_submitted,
             MAX(k.fetched_at)                AS measured_at
      FROM keyed k
      GROUP BY k.ckey
    )
    SELECT * FROM (
      SELECT g.*,
             COUNT(*) OVER ()                                   AS total_groups,
             COUNT(*) FILTER (WHERE g.views IS NOT NULL) OVER () AS ranked_groups
      FROM grouped g
    ) w
    -- ⚠️ The views filter MUST sit outside the window subquery. SQL applies WHERE
    -- BEFORE window functions, so filtering in the same SELECT would make
    -- COUNT(*) OVER () count only the ROWS THAT SURVIVED — i.e. total would equal
    -- ranked, always, and the card's coverage line would read "15,503 of 15,503".
    -- Caught by the "excludes a row with no view count" test, which seeds exactly
    -- one of each.
    WHERE w.views IS NOT NULL
    ORDER BY w.views DESC, w.ckey ASC
    LIMIT ${LIMIT}
  `;

  // ⚠️ The denominators ride along as WINDOW functions over `grouped`, which is why
  // there is only ONE query here. They used to be a second statement that re-ran the
  // whole derived-key CASE over the window — measured on prod at 90d/all that made the
  // card 7.0s. Window functions are evaluated over the full grouped set BEFORE the
  // LIMIT, so these are the true totals, not the totals of the 20 rows returned.
  //
  // ⚠️ Both are 0 when `rows` is empty, and that is correct: no group in the window
  // means nothing to count. Do not "fix" it by falling back to a second query.
  const ranked = rows.length ? Number(rows[0].ranked_groups) : 0;
  const total = rows.length ? Number(rows[0].total_groups) : 0;

  // ── Preview + title, from posts we happen to own. Strictly bounded: at most LIMIT
  // ids, looked up on the match_id index. A miss is normal and costs only a thumbnail.
  const wanted = new Map<string, string>(); // matchId -> canonical key
  for (const r of rows) {
    const mid = matchIdFromUrl(r.platform, r.url);
    if (mid) wanted.set(mid, r.ckey);
  }
  const owned = wanted.size
    ? await prisma.metaPost.findMany({
        where: { matchId: { in: [...wanted.keys()] } },
        select: {
          matchId: true,
          caption: true,
          thumbnailUrl: true,
          postedAt: true,
          asset: { select: { name: true, username: true } },
        },
        // ⚠️ A post cross-posted to two assets yields two rows. `postedAt: desc` is
        // NULLS FIRST in Postgres, so a null-dated row would beat a real one — the id
        // tie-break makes the pick deterministic instead of plan-dependent, and the
        // reducer below prefers whichever row actually carries a thumbnail.
        orderBy: [{ postedAt: "desc" }, { id: "asc" }],
        take: wanted.size * 4,
      })
    : [];
  const byMatch = new Map<string, (typeof owned)[number]>();
  for (const p of owned) {
    if (!p.matchId) continue;
    const cur = byMatch.get(p.matchId);
    if (!cur || (!cur.thumbnailUrl && p.thumbnailUrl)) byMatch.set(p.matchId, p);
  }

  let withPreview = 0;
  const posts: TopPost[] = rows.map((r) => {
    const mid = matchIdFromUrl(r.platform, r.url);
    const own = mid ? byMatch.get(mid) : undefined;
    const thumbnailUrl = thumbnailIfFresh(own?.thumbnailUrl, nowMs);
    if (thumbnailUrl) withPreview++;
    return {
      urlNormalized: r.ckey,
      url: r.url,
      platform: r.platform,
      views: num(r.views),
      likes: num(r.likes),
      comments: num(r.comments),
      submitters: Number(num(r.submitters) ?? 1),
      lastSubmitted: r.last_submitted.toISOString().slice(0, 10),
      measuredAt: r.measured_at.toISOString(),
      title: firstLine(own?.caption ?? null),
      thumbnailUrl,
      channel: own?.asset?.username ? `@${own.asset.username}` : (own?.asset?.name ?? null),
    };
  });

  return {
    platform: params.platform,
    days: params.days,
    start,
    end,
    posts,
    ranked: Number(ranked ?? 0),
    total: Number(total ?? 0),
    withPreview,
  };
}
