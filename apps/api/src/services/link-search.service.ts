import { prisma } from "@dashmani/db";
import type { Prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";

/**
 * Stage 3 — Link entity search.
 *
 * An admin types a person/topic ("salman khan"). We resolve it to an `Entity`,
 * walk the join to its `LinkContent.canonicalKey` set, then find EVERY
 * `report_links` row whose post maps to one of those keys, and report
 * SAME-vs-UNIQUE: total posts (every row), unique posts (distinct canonicalKey),
 * duplicates, channel breakdown, the full posts list, and coverage. We NEVER
 * dedupe rows away — same-vs-unique is the whole point.
 *
 * ⚠️ OOM SAFETY (the load-bearing design constraint):
 * Prod has ~30k report_links on a 2GB box. We must never load the whole table
 * into Node. `canonicalKey()` is a JS function Postgres can't run, and
 * report_links has no canonicalKey column, so we can't join on the key directly.
 * Instead we push a COARSE prefilter into Postgres: for each of the entity's
 * (tens-to-hundreds of) canonicalKeys we derive the URL substring it must
 * contain (`yt:ID` → url contains `ID`; `ig:CODE` → url contains `/CODE`;
 * `fb:NUM` → url contains `NUM`; full-url-fallback → url equals that string,
 * case-insensitive) and build `where: { OR: [...contains] }`. The candidate set
 * that comes back ≈ the entity's posts (a few hundred), NOT the whole table.
 * Then in JS we recompute `canonicalKey(row.url)` on just those candidates and
 * keep only exact matches — the `contains` is the prefilter, the JS key is the
 * exact arbiter. This is correct AND bounded because the candidate set is tiny.
 */

const CANDIDATE_TAKE = 5000; // hard cap on the bounded candidate fetch

export interface LinkSearchResult {
  entity: { id: string; canonicalName: string; type: string; aliases: string[] } | null;
  disambiguation?: Array<{ id: string; canonicalName: string; type: string }>; // when >1 entity matches
  totalPosts: number; // every matching report_links row
  uniquePosts: number; // distinct canonicalKey
  duplicatePosts: number; // totalPosts - uniquePosts
  channelCount: number; // distinct account
  channels: Array<{ accountId: string; handle: string; displayName: string; platform: string; postCount: number }>;
  posts: Array<{
    canonicalKey: string;
    url: string;
    platform: string;
    account: { id: string; handle: string; displayName: string };
    employee: { id: string; name: string };
    date: string;
    dupCount: number;
  }>;
  coverage: {
    // ── Legacy fields (kept for back-compat; `enriched`/`total` were the old
    //    "N of M" pair where M counted attempted rows incl. not_found). ──────────
    enriched: number;
    notYetEnriched: number;
    total: number;
    // ── Honest accuracy fields (self-healing — a permanently-unsearchable link can
    //    never inflate the "searchable" tally) ─────────────────────────────────
    // searchable        = link_content rows with status='ok' (caption captured)
    // pendingExtraction = status='ok' AND extractedAt IS NULL (captured but not yet tagged)
    // nameSearchable    = searchable - pendingExtraction (actually findable by name right now)
    // unsearchable      = rows tried but unfindable (not_found/error/private/unsupported)
    // submitted         = the real report_links universe (the honest denominator)
    searchable: number;
    pendingExtraction: number; // captured captions not yet tagged with people/topics
    nameSearchable: number;    // actually findable by name right now (searchable - pendingExtraction)
    unsearchable: number;
    submitted: number;
    byPlatform: Record<
      string,
      {
        enriched: number; // == searchable; kept for back-compat with older UI
        total: number; // == attempted (ok + unsearchable); kept for back-compat
        searchable: number;
        pendingExtraction: number; // captured but not yet entity-tagged for this platform
        nameSearchable: number;    // searchable - pendingExtraction for this platform
        unsearchable: number;
        submitted: number; // report_links for this platform (the honest denominator)
        since?: string; // earliest enriched fetched_at — auto-detected coverage date
      }
    >;
  };
  truncated?: boolean;
}

/**
 * The URL substring that a report_links.url MUST contain for a given
 * canonicalKey. Used to build the bounded Postgres prefilter. Returns null for
 * the full-url-fallback case (handled separately as an exact, case-insensitive
 * url equality so we don't substring-match arbitrary URLs).
 */
function idPartFor(canonicalKeyValue: string): { contains?: string; equalsUrl?: string } {
  if (canonicalKeyValue.startsWith("yt:")) return { contains: canonicalKeyValue.slice(3) };
  if (canonicalKeyValue.startsWith("ig:")) return { contains: `/${canonicalKeyValue.slice(3)}` };
  if (canonicalKeyValue.startsWith("fb:")) return { contains: canonicalKeyValue.slice(3) };
  if (canonicalKeyValue.startsWith("sc:spotlight:")) return { contains: canonicalKeyValue.slice("sc:spotlight:".length) };
  if (canonicalKeyValue.startsWith("sc:story:")) return { contains: canonicalKeyValue.slice("sc:story:".length) };
  // Full-URL fallback key (already lowercased). Match the url exactly, case-insensitive.
  return { equalsUrl: canonicalKeyValue };
}

type CoverageBucket = LinkSearchResult["coverage"]["byPlatform"][string];

// Coverage is a global aggregate — it only changes when the enrichment cron
// runs (at most hourly). Re-computing it on every search burns 5 heavy queries
// per keystroke. Cache it for 5 minutes; expose an invalidator for tests.
const COVERAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _coverageCache: { value: LinkSearchResult["coverage"]; builtAt: number } | null = null;

export function invalidateCoverageCache(): void {
  _coverageCache = null;
}

async function buildCoverage(): Promise<LinkSearchResult["coverage"]> {
  const now = Date.now();
  if (_coverageCache && now - _coverageCache.builtAt < COVERAGE_TTL_MS) {
    return _coverageCache.value;
  }

  // Four cheap grouped queries:
  //  1. link_content counts by (platform, status) — searchable (ok) vs unsearchable
  //  2. earliest enriched fetched_at per platform — the auto-detected "since" date
  //  3. report_links count by platform — the HONEST denominator (what was submitted)
  //  4. link_content rows with status='ok' AND extractedAt IS NULL — captured but not
  //     yet entity-tagged (pendingExtraction). These are captions we have but haven't
  //     yet run the LLM tagging pass on, so they're NOT findable by name yet.
  //
  // The accuracy fix: a permanently-unsearchable link (FB not_found) must NOT count
  // toward "searchable", and the denominator is "submitted", not "attempted". So a
  // platform with few enriched rows (e.g. FB/IG historical posts beyond the firehose
  // window) shows e.g. "0 searchable of 18,909 submitted" — never "X of Y enriched"
  // where Y silently grows with failed attempts.
  // SEARCHABLE = captions whose canonicalKey matches a SUBMITTED link — the
  // intersection of link_content(status='ok') and report_links. This is the
  // critical correctness fix (2026-06-27): the old numerator counted ALL ok
  // captions, including ones HARVESTED from administered-Page feeds that no
  // employee ever submitted as a link (~12.8k FB, ~8.5k IG). Counting those made
  // "searchable" exceed "submitted" on FB (26k of 22k — impossible on its face)
  // and silently over-counted IG too. "Searchable of submitted" must mean a
  // SUBSET of submitted, so the numerator is bounded by the denominator.
  //
  // OOM-SAFE: this is a COUNT over a join keyed on derived ids, never a row load.
  // We derive each report_links URL's canonicalKey-equivalent id in SQL (the same
  // shapes canonicalKey() produces: yt:<id>, ig:<shortcode>, fb:<numeric>) and
  // intersect with link_content.canonicalKey. Opaque/unparseable URLs derive to
  // NULL and correctly don't match. The per-post search path is unchanged — this
  // only fixes the aggregate COVERAGE banner.
  // The derived submitted-key CTE is reused by both the searchable and the
  // pending-extraction intersections, so define it once as a SQL fragment.
  // (Inlined into each query below — Prisma $queryRaw doesn't share CTEs across calls.)
  const searchableByPlatform = prisma.$queryRaw<Array<{ platform: string; searchable: bigint }>>`
    WITH submitted_keys AS (
      SELECT DISTINCT
        CASE
          WHEN url ~* 'youtube\.com/watch\?v=|youtube\.com/shorts/|youtu\.be/|youtube\.com/embed/'
            THEN 'yt:' || substring(url from '(?:v=|/shorts/|youtu\.be/|/embed/)([A-Za-z0-9_-]{6,})')
          WHEN url ~* 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/'
            THEN 'ig:' || substring(url from 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)')
          WHEN url ~* 'facebook\.com/reel/[0-9]'
            THEN 'fb:' || substring(url from 'facebook\.com/reel/([0-9]+)')
          WHEN url ~* 'snapchat\.com/spotlight/'
            THEN 'sc:spotlight:' || substring(url from 'snapchat\.com/spotlight/([^/?#]+)')
          WHEN url ~* 'snapchat\.com/s/'
            THEN 'sc:story:' || substring(url from 'snapchat\.com/s/([^/?#]+)')
          ELSE NULL
        END AS k
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
    )
    SELECT lc.platform AS platform, count(*)::bigint AS searchable
    FROM link_content lc
    JOIN submitted_keys sk ON sk.k = lc."canonicalKey"
    WHERE lc.status = 'ok'
    GROUP BY lc.platform
  `;

  // pendingExtraction, intersected with submitted links the SAME way as searchable —
  // so nameSearchable = searchable - pendingExtraction stays consistent (both count
  // only submitted-matching captions). A harvested-not-submitted untagged caption
  // must NOT count as "pending" against the submitted denominator.
  const pendingMatchedByPlatform = prisma.$queryRaw<Array<{ platform: string; pending: bigint }>>`
    WITH submitted_keys AS (
      SELECT DISTINCT
        CASE
          WHEN url ~* 'youtube\.com/watch\?v=|youtube\.com/shorts/|youtu\.be/|youtube\.com/embed/'
            THEN 'yt:' || substring(url from '(?:v=|/shorts/|youtu\.be/|/embed/)([A-Za-z0-9_-]{6,})')
          WHEN url ~* 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/'
            THEN 'ig:' || substring(url from 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)')
          WHEN url ~* 'facebook\.com/reel/[0-9]'
            THEN 'fb:' || substring(url from 'facebook\.com/reel/([0-9]+)')
          WHEN url ~* 'snapchat\.com/spotlight/'
            THEN 'sc:spotlight:' || substring(url from 'snapchat\.com/spotlight/([^/?#]+)')
          WHEN url ~* 'snapchat\.com/s/'
            THEN 'sc:story:' || substring(url from 'snapchat\.com/s/([^/?#]+)')
          ELSE NULL
        END AS k
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
    )
    SELECT lc.platform AS platform, count(*)::bigint AS pending
    FROM link_content lc
    JOIN submitted_keys sk ON sk.k = lc."canonicalKey"
    WHERE lc.status = 'ok' AND lc.extracted_at IS NULL
    GROUP BY lc.platform
  `;

  const [grouped, sinceByPlatform, submittedByPlatform, pendingMatched, searchableMatched] = await Promise.all([
    prisma.linkContent.groupBy({
      by: ["platform", "status"],
      _count: { _all: true },
    }),
    // "Capturing since" = when we FIRST captured a caption for this platform. Use
    // createdAt (set once at insert), NOT fetchedAt — upsertLinkContent bumps fetchedAt
    // on every re-harvest, so min(fetchedAt) drifts FORWARD as old anchor rows age out
    // (F9). createdAt is immutable → a true, stable start date.
    prisma.linkContent.groupBy({
      by: ["platform"],
      where: { status: "ok" },
      _min: { createdAt: true },
    }),
    // Per-platform SUBMITTED denominator, bucketed by URL HOST (F8) — the numerator
    // (searchable) buckets by link_content.platform which is derived from the URL's
    // canonicalKey, so the denominator must match. The old groupBy on the DIRTY
    // report_links.platform column mis-split IG/FB by ~2,200 (the aggregate was right,
    // only the split misled). ELSE keeps the platform column so no row is dropped — the
    // total is identical, only the bucketing is corrected.
    prisma.$queryRaw<Array<{ platform: string; cnt: bigint }>>`
      SELECT CASE
        WHEN url ~* 'youtube\.com|youtu\.be' THEN 'youtube'
        WHEN url ~* 'instagram\.com' THEN 'instagram'
        WHEN url ~* 'facebook\.com|fb\.watch|fb\.me' THEN 'facebook'
        WHEN url ~* 'snapchat\.com|story\.snapchat\.com' THEN 'snapchat'
        ELSE lower(coalesce(platform, 'other'))
      END AS platform, count(*)::bigint AS cnt
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
      GROUP BY 1
    `,
    pendingMatchedByPlatform,
    searchableByPlatform,
  ]);

  const ensure = (map: Record<string, CoverageBucket>, p: string): CoverageBucket => {
    if (!map[p]) map[p] = { enriched: 0, total: 0, searchable: 0, pendingExtraction: 0, nameSearchable: 0, unsearchable: 0, submitted: 0 };
    return map[p];
  };

  let searchable = 0;
  let unsearchable = 0;
  const byPlatform: Record<string, CoverageBucket> = {};

  // SEARCHABLE — captions matching a submitted link (the intersection query). This
  // is a SUBSET of submitted by construction, so it can never exceed the denominator.
  for (const s of searchableMatched) {
    const p = (s.platform || "other").toLowerCase();
    const n = Number(s.searchable);
    ensure(byPlatform, p).searchable += n;
    byPlatform[p].enriched += n; // legacy alias (== searchable)
    searchable += n;
  }

  // UNSEARCHABLE — captions we TRIED but couldn't use (not_found/error/private/etc).
  // Counted from link_content non-ok rows. (We don't intersect these with submitted
  // links — they're a "we attempted N and they failed" signal, kept for the legacy
  // `total`/`notYetEnriched` fields; the headline now leads with searchable/submitted.)
  for (const g of grouped) {
    const n = g._count._all;
    const p = (g.platform || "other").toLowerCase();
    const b = ensure(byPlatform, p);
    if (g.status === "ok") {
      b.total += n; // attempted includes ok (legacy)
    } else {
      b.total += n;
      b.unsearchable += n;
      unsearchable += n;
    }
  }

  // report_links submitted-per-platform (honest denominator), bucketed by URL host to
  // match the numerator's source (F8) — no longer the dirty platform column.
  for (const s of submittedByPlatform) {
    const p = (s.platform || "other").toLowerCase();
    ensure(byPlatform, p).submitted += Number(s.cnt);
  }

  // Auto-detected per-platform coverage date (earliest enriched createdAt — immutable).
  for (const s of sinceByPlatform) {
    const p = (s.platform || "other").toLowerCase();
    const min = s._min.createdAt;
    if (byPlatform[p] && min) byPlatform[p].since = min.toISOString();
  }

  // Pending extraction: status='ok' AND extractedAt IS NULL, INTERSECTED with
  // submitted links (same as searchable) — captured but not yet entity-tagged, so
  // not findable BY NAME yet. Intersecting keeps nameSearchable = searchable -
  // pendingExtraction consistent (both over the submitted-matching universe).
  let pendingExtraction = 0;
  for (const g of pendingMatched) {
    const p = (g.platform || "other").toLowerCase();
    const n = Number(g.pending);
    ensure(byPlatform, p).pendingExtraction += n;
    pendingExtraction += n;
  }

  // Per-platform nameSearchable = searchable - pendingExtraction (clamped at 0).
  for (const b of Object.values(byPlatform)) {
    b.nameSearchable = Math.max(0, b.searchable - b.pendingExtraction);
  }

  const attemptedTotal = searchable + unsearchable;
  const submitted = Object.values(byPlatform).reduce((acc, b) => acc + b.submitted, 0);
  const nameSearchable = Math.max(0, searchable - pendingExtraction);

  const result: LinkSearchResult["coverage"] = {
    // legacy pair (enriched = searchable; total = attempted)
    enriched: searchable,
    notYetEnriched: attemptedTotal - searchable,
    total: attemptedTotal,
    // honest fields
    searchable,
    pendingExtraction,
    nameSearchable,
    unsearchable,
    submitted,
    byPlatform,
  };

  _coverageCache = { value: result, builtAt: Date.now() };
  return result;
}

function emptyResult(coverage: LinkSearchResult["coverage"], extra?: Partial<LinkSearchResult>): LinkSearchResult {
  return {
    entity: null,
    totalPosts: 0,
    uniquePosts: 0,
    duplicatePosts: 0,
    channelCount: 0,
    channels: [],
    posts: [],
    coverage,
    ...extra,
  };
}

export async function searchLinksByEntity(params: {
  q: string;
  from?: string;
  to?: string;
  platform?: string;
}): Promise<LinkSearchResult> {
  const coverage = await buildCoverage();

  const q = (params.q || "").trim();
  if (!q) {
    // Empty query → zero result, but coverage is still filled so the UI can
    // explain "0 — but only N of M enriched".
    return emptyResult(coverage);
  }

  // ── Resolve the entity ──────────────────────────────────────────────────
  // Partial name match (ILIKE %q%) OR exact alias (aliases are stored lowercase).
  const matches = await prisma.entity.findMany({
    where: {
      OR: [
        { canonicalName: { contains: q, mode: "insensitive" } },
        { aliases: { has: q.toLowerCase() } },
      ],
    },
    select: { id: true, canonicalName: true, type: true, aliases: true },
    orderBy: { canonicalName: "asc" },
  });

  if (matches.length === 0) return emptyResult(coverage);

  // EXACT-MATCH SHORT-CIRCUIT (fixes the disambiguation infinite loop, F4/2026-06-26):
  // a `contains` query for "Kareena Kapoor" also matches "Kareena Kapoor Khan", so a
  // shorter name whose string is a substring of a longer one would disambiguate
  // FOREVER — clicking the chip re-sends the same name and never resolves (141 entities,
  // incl. the largest, were unreachable). When `q` EXACTLY equals one entity's
  // canonicalName (case-insensitive) or one of its aliases, resolve straight to it —
  // that's the entity the user picked. Only fall to disambiguation for a genuinely
  // ambiguous partial (no exact hit, multiple contains-matches).
  const qLower = q.toLowerCase();
  const exact = matches.filter(
    (m) => m.canonicalName.toLowerCase() === qLower || m.aliases.some((a) => a.toLowerCase() === qLower)
  );

  // Resolve the entity. The exact-match short-circuit (F4) handles the
  // substring-prefix loop. But a query can EXACT-match >1 entity when the same name
  // is one entity's canonicalName AND another's alias — which happens after an
  // entity MERGE leaves the folded name as an alias, and the live extraction cron
  // (briefly, before its own alias-resolution catches up) re-creates a thin
  // duplicate under that canonicalName. Disambiguating those two against each other
  // loops forever (clicking the chip re-sends the same name → same 2 matches). So
  // when multiple entities exact-match, DON'T loop — pick a single winner:
  //   1) prefer a canonicalName exact-match over an alias-only match, else
  //   2) the entity with the most linked posts (the real, populated one).
  // Only genuinely ambiguous PARTIALS (no exact hit, >1 contains-match) disambiguate.
  let entity: (typeof matches)[number];
  if (exact.length === 1) {
    entity = exact[0];
  } else if (exact.length > 1) {
    // Multiple exact matches → resolve to a single winner, never loop. Pick the
    // entity with the MOST linked posts — that's the real, populated identity. (Do
    // NOT prefer a canonicalName-match here: in the post-merge duplicate case the
    // THIN duplicate is the one whose canonicalName equals the query, while the
    // real SURVIVOR carries the name as an alias — link-count is the honest tiebreak.)
    const counts = await prisma.linkContentEntity.groupBy({
      by: ["entityId"],
      where: { entityId: { in: exact.map((m) => m.id) } },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.entityId, c._count._all]));
    entity = exact.reduce((best, m) =>
      (countById.get(m.id) ?? 0) > (countById.get(best.id) ?? 0) ? m : best,
    );
  } else if (matches.length > 1) {
    // No exact hit + multiple partial matches → genuine disambiguation.
    return emptyResult(coverage, {
      disambiguation: matches.map((m) => ({ id: m.id, canonicalName: m.canonicalName, type: m.type })),
    });
  } else {
    entity = matches[0];
  }

  // ── The entity's canonicalKeys (small: tens-to-hundreds) ──────────────────
  const joins = await prisma.linkContentEntity.findMany({
    where: { entityId: entity.id },
    select: { content: { select: { canonicalKey: true } } },
  });
  const keys = Array.from(new Set(joins.map((j) => j.content.canonicalKey).filter(Boolean)));

  const entityOut = { id: entity.id, canonicalName: entity.canonicalName, type: entity.type, aliases: entity.aliases };

  if (keys.length === 0) {
    // Entity exists but has no linked content yet → no posts, coverage filled.
    return emptyResult(coverage, { entity: entityOut });
  }

  // ── Build the BOUNDED Postgres prefilter from the entity's keys ───────────
  // This `where` is constrained to the entity's canonicalKeys — the candidate
  // set Postgres returns ≈ the entity's posts, not the whole report_links table.
  const orFilters: Prisma.ReportLinkWhereInput[] = [];
  for (const key of keys) {
    const part = idPartFor(key);
    if (part.contains) orFilters.push({ url: { contains: part.contains, mode: "insensitive" } });
    else if (part.equalsUrl) orFilters.push({ url: { equals: part.equalsUrl, mode: "insensitive" } });
  }

  const where: Prisma.ReportLinkWhereInput = {
    url: { not: null },
    OR: orFilters,
  };
  if (params.platform) {
    // platform on report_links is a free-text column; match case-insensitively.
    where.platform = { equals: params.platform, mode: "insensitive" };
  }
  // Optional inclusive day-level window on the parent report's date.
  // daily_reports.date is @db.Date. We keep this simple: from/to are interpreted
  // as inclusive day bounds (gte from-midnight, lte to-end-of-day). Default is no window.
  if (params.from || params.to) {
    const dateFilter: Prisma.DateTimeFilter = {};
    if (params.from) dateFilter.gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) dateFilter.lte = new Date(`${params.to}T23:59:59.999Z`);
    where.report = { date: dateFilter };
  }

  // Fetch the bounded candidate set (cap at CANDIDATE_TAKE; flag if it overflows).
  const candidates = await prisma.reportLink.findMany({
    where,
    take: CANDIDATE_TAKE + 1, // +1 to detect overflow without a second count
    select: {
      id: true,
      url: true,
      platform: true,
      account: { select: { id: true, handle: true, displayName: true } },
      report: { select: { date: true, employee: { select: { id: true, name: true } } } },
    },
  });

  let truncated = false;
  let rows = candidates;
  if (candidates.length > CANDIDATE_TAKE) {
    truncated = true;
    rows = candidates.slice(0, CANDIDATE_TAKE);
    // Honest, not silent: log that the result set was capped.
    console.warn(
      `[link-search] candidate fetch for entity "${entity.canonicalName}" exceeded ${CANDIDATE_TAKE} rows — result truncated`,
    );
  }

  // ── Exact match in JS: the contains prefilter is coarse; canonicalKey is the
  // exact arbiter. Keep only rows whose recomputed key is in the entity's set.
  const keySet = new Set(keys);
  const matched = rows.filter((r) => r.url && keySet.has(canonicalKey(r.url)));

  // ── Group by canonicalKey for unique/dup counts ───────────────────────────
  const byKey = new Map<string, number>();
  for (const r of matched) {
    const k = canonicalKey(r.url!);
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }

  // ── Channels (distinct account, postCount per account) ────────────────────
  const channelMap = new Map<
    string,
    { accountId: string; handle: string; displayName: string; platform: string; postCount: number }
  >();
  for (const r of matched) {
    const acc = r.account;
    const existing = channelMap.get(acc.id);
    if (existing) existing.postCount += 1;
    else
      channelMap.set(acc.id, {
        accountId: acc.id,
        handle: acc.handle,
        displayName: acc.displayName,
        platform: r.platform,
        postCount: 1,
      });
  }

  // ── Posts list (EVERY row; dupCount = how many rows share that key) ────────
  const posts = matched.map((r) => {
    const k = canonicalKey(r.url!);
    return {
      canonicalKey: k,
      url: r.url!,
      platform: r.platform,
      account: { id: r.account.id, handle: r.account.handle, displayName: r.account.displayName },
      employee: { id: r.report.employee.id, name: r.report.employee.name },
      date: r.report.date.toISOString().slice(0, 10),
      dupCount: byKey.get(k) || 1,
    };
  });

  const totalPosts = matched.length;
  const uniquePosts = byKey.size;

  return {
    entity: entityOut,
    totalPosts,
    uniquePosts,
    duplicatePosts: totalPosts - uniquePosts,
    channelCount: channelMap.size,
    channels: Array.from(channelMap.values()).sort((a, b) => b.postCount - a.postCount),
    posts,
    coverage,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Entity autocomplete for the search typeahead. */
export async function listEntities(
  q: string,
): Promise<Array<{ id: string; canonicalName: string; type: string }>> {
  const term = (q || "").trim();
  if (!term) return [];
  return prisma.entity.findMany({
    where: {
      OR: [
        { canonicalName: { contains: term, mode: "insensitive" } },
        { aliases: { has: term.toLowerCase() } },
      ],
    },
    take: 10,
    orderBy: { canonicalName: "asc" },
    select: { id: true, canonicalName: true, type: true },
  });
}
