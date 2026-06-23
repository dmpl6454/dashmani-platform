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
    enriched: number;
    notYetEnriched: number;
    total: number;
    // `since` is the earliest enriched (status='ok') fetched_at for the platform —
    // the auto-detected date from which IG/FB results are reliable. Absent when the
    // platform has no enriched rows yet. Additive: older API responses omit it and
    // the UI tolerates that.
    byPlatform: Record<string, { enriched: number; total: number; since?: string }>;
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
  // Full-URL fallback key (already lowercased). Match the url exactly, case-insensitive.
  return { equalsUrl: canonicalKeyValue };
}

async function buildCoverage(): Promise<LinkSearchResult["coverage"]> {
  // Coverage is the honest "N of M" the UI shows: the LinkContent universe.
  // Two cheap grouped queries: counts by (platform, status), and the earliest
  // enriched fetched_at per platform (the auto-detected "since" coverage date).
  const [grouped, sinceByPlatform] = await Promise.all([
    prisma.linkContent.groupBy({
      by: ["platform", "status"],
      _count: { _all: true },
    }),
    prisma.linkContent.groupBy({
      by: ["platform"],
      where: { status: "ok", fetchedAt: { not: null } },
      _min: { fetchedAt: true },
    }),
  ]);

  let enriched = 0;
  let total = 0;
  const byPlatform: Record<string, { enriched: number; total: number; since?: string }> = {};
  for (const g of grouped) {
    const n = g._count._all;
    total += n;
    if (g.status === "ok") enriched += n;
    const p = g.platform || "other";
    if (!byPlatform[p]) byPlatform[p] = { enriched: 0, total: 0 };
    byPlatform[p].total += n;
    if (g.status === "ok") byPlatform[p].enriched += n;
  }
  // Attach the per-platform "since" date (earliest enriched fetched_at).
  for (const s of sinceByPlatform) {
    const p = s.platform || "other";
    const min = s._min.fetchedAt;
    if (byPlatform[p] && min) byPlatform[p].since = min.toISOString();
  }
  return { enriched, notYetEnriched: total - enriched, total, byPlatform };
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
  if (matches.length > 1) {
    return emptyResult(coverage, {
      disambiguation: matches.map((m) => ({ id: m.id, canonicalName: m.canonicalName, type: m.type })),
    });
  }

  const entity = matches[0];

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
