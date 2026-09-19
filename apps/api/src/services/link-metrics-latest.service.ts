import { prisma } from "@dashmani/db";

// ── link_metrics_latest: the READ model for engagement ─────────────────────────
//
// One row per (employee_id, url_normalized) = the newest snapshot with status='ok'.
// See the model comment in packages/db/prisma/schema.prisma for the incident that
// made this necessary (2026-09-18: DISTINCT ON over the 14.6M-row snapshot log took
// 5-10 min per read, drained the pool, and took login + HR submit down with it).
//
// Three responsibilities, all called from the social-insights cron:
//   1. upsertLinkMetricLatest — newer fetched_at wins; an older write is a no-op, so
//      the one-off backfill and the live cron can run in either order concurrently.
//   2. findLatestSnapshotsByLinkIds / isIdenticalSnapshot — the write-dedupe
//      reference. The sweep re-polls the same links every 2h; when the result is
//      byte-identical to the link's last stored snapshot (same status AND same
//      views/likes/comments/shares) there is nothing new to record, so the cron
//      skips appending another row to link_metrics. Measured 2026-09-17: 760k of
//      872k Instagram writes/day were identical `not_found` re-polls.
//   3. rehealLinkMetricLatest — mirrors the link_metrics re-heal: relink rows whose
//      link_id was SetNull'd by the HR delete-and-recreate resubmit.

export interface LatestSnapshotInput {
  employeeId: string;
  urlNormalized: string;
  linkId: string | null;
  reportDate: Date;
  url: string;
  platform: string;
  videoId: string | null;
  fetchedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/**
 * Upsert the latest OK snapshot for (employee, url). Newer `fetchedAt` wins; a write
 * carrying an older `fetchedAt` than the stored row is a no-op. Returns true when a
 * row was inserted or updated.
 *
 * Callers are responsible for only passing status='ok' results — this table must
 * never hold a not_found/error row (a link whose newest poll failed keeps showing its
 * last good values, exactly like the old `... WHERE status='ok'` DISTINCT ON did).
 */
export async function upsertLinkMetricLatest(s: LatestSnapshotInput): Promise<boolean> {
  const n = await prisma.$executeRaw`
    INSERT INTO link_metrics_latest
      (employee_id, url_normalized, link_id, report_date, url, platform, video_id,
       fetched_at, views, likes, comments, shares)
    VALUES
      (${s.employeeId}, ${s.urlNormalized}, ${s.linkId}::text, ${s.reportDate}::date,
       ${s.url}, ${s.platform}, ${s.videoId}::text, ${s.fetchedAt}::timestamp(3),
       ${s.views}::int, ${s.likes}::int, ${s.comments}::int, ${s.shares}::int)
    ON CONFLICT (employee_id, url_normalized) DO UPDATE SET
      link_id     = EXCLUDED.link_id,
      report_date = EXCLUDED.report_date,
      url         = EXCLUDED.url,
      platform    = EXCLUDED.platform,
      video_id    = EXCLUDED.video_id,
      fetched_at  = EXCLUDED.fetched_at,
      views       = EXCLUDED.views,
      likes       = EXCLUDED.likes,
      comments    = EXCLUDED.comments,
      shares      = EXCLUDED.shares
    WHERE EXCLUDED.fetched_at > link_metrics_latest.fetched_at
  `;
  return n > 0;
}

export interface StoredSnapshotShape {
  status: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** When this stored snapshot was taken — the reference for the views-only floor. */
  fetchedAt: Date;
}

/**
 * Latest stored snapshot (ANY status) per link id, for the batch just polled. One
 * indexed query per batch (`link_metrics_link_id_idx`), bounded by the batch size.
 * Empty input → empty map, no query.
 */
export async function findLatestSnapshotsByLinkIds(
  linkIds: string[],
): Promise<Map<string, StoredSnapshotShape>> {
  const out = new Map<string, StoredSnapshotShape>();
  if (linkIds.length === 0) return out;
  const rows = await prisma.$queryRaw<
    Array<{
      link_id: string;
      status: string;
      fetched_at: Date;
      views: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
    }>
  >`
    SELECT DISTINCT ON (link_id) link_id, status, views, likes, comments, shares, fetched_at
    FROM link_metrics
    WHERE link_id = ANY(${linkIds}::text[])
    ORDER BY link_id, fetched_at DESC
  `;
  for (const r of rows) {
    out.set(r.link_id, {
      status: r.status,
      fetchedAt: r.fetched_at,
      views: r.views,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
    });
  }
  return out;
}

/**
 * True when a fresh poll result carries nothing the last stored snapshot doesn't:
 * same status and the same four metric values (null and undefined are the same
 * absence). Error messages are deliberately NOT compared — they can carry
 * timestamps/ids and would defeat the dedupe for repeated failures.
 */
/**
 * Minimum spacing between HISTORY rows whose only difference is a views tick.
 *
 * ⚠️ THIS EXISTS BECAUSE VIEWS ARE A MONOTONIC COUNTER AND THE SWEEP IS RELENTLESS.
 * Measured on prod 2026-09-19, one Instagram sweep: 68,827 links polled, 9,175 ok, and
 * 67,190 suppressed as identical — only ~1,600 rows appended. Instagram reached that
 * state only because its views were ALWAYS NULL, so an ok re-poll whose likes and
 * comments had not moved was byte-identical and skipped.
 *
 * Populating real Instagram views (2026-09-19) breaks that by construction: a view
 * count ticks between almost any two polls, so nearly every one of those 9,175 ok polls
 * would append a row — ~110,000 rows/day against today's ~37,900, i.e. roughly +26M
 * rows and +20GB a year on a table ALREADY at 14.8M rows / 11GB, on a disk at 78% of
 * 49GB. That is precisely the growth curve that made the "latest per link" reads take
 * 5-10 minutes and took the LOGIN PAGE down on 2026-09-18.
 *
 * ⚠️ Suppressing these costs no reader anything. Since that same incident, NOTHING on a
 * portal path reads link_metrics for engagement — every consumer reads
 * link_metrics_latest, which is an UPSERT (one row per link, no growth) and is still
 * refreshed on EVERY ok poll. link_metrics is the per-link history behind
 * getLinkMetricsHistory alone, and a views curve sampled daily tells that drill-down
 * the same story as one sampled every two hours.
 *
 * ⚠️ Deliberately platform-agnostic, and deliberately a TIME FLOOR rather than a
 * views-only blacklist: YouTube's history is mostly views changes, so dropping them
 * outright would flatten its chart. A daily sample keeps every platform's curve.
 */
export const VIEWS_ONLY_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

type NextSnapshot = { status: string; views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null };

const sameNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);

/** Status and every metric EXCEPT views match, and views genuinely moved. */
export function isViewsOnlyChange(prev: StoredSnapshotShape, next: NextSnapshot): boolean {
  return (
    prev.status === next.status &&
    sameNum(prev.likes, next.likes) &&
    sameNum(prev.comments, next.comments) &&
    sameNum(prev.shares, next.shares) &&
    !sameNum(prev.views, next.views)
  );
}

/**
 * Should this poll result be APPENDED to the link_metrics history?
 *
 * No stored snapshot → yes. Byte-identical → no. Only the view counter moved → only if
 * the stored row is at least VIEWS_ONLY_MIN_INTERVAL_MS old. Anything else (a status
 * change, a like, a comment, a share) → always yes, immediately.
 *
 * ⚠️ FAIL-OPEN BY SHAPE: the cron passes `prev = undefined` when its lookup failed, and
 * that returns true — every result is written, i.e. the pre-dedupe behaviour. A bug
 * here can cost disk; it must never cost data.
 */
export function shouldAppendSnapshot(
  prev: StoredSnapshotShape | undefined,
  next: NextSnapshot,
  now: Date,
): boolean {
  if (prev == null) return true;
  if (isIdenticalSnapshot(prev, next)) return false;
  if (isViewsOnlyChange(prev, next)) {
    // ⚠️ FAIL OPEN on a missing/invalid timestamp. A caller that cannot tell us WHEN the
    // stored row was written cannot be told to suppress — the floor is a disk
    // optimisation, and losing a history row is worse than writing an extra one.
    const t = prev.fetchedAt instanceof Date ? prev.fetchedAt.getTime() : NaN;
    if (!Number.isFinite(t)) return true;
    return now.getTime() - t >= VIEWS_ONLY_MIN_INTERVAL_MS;
  }
  return true;
}

export function isIdenticalSnapshot(
  prev: StoredSnapshotShape,
  next: { status: string; views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null },
): boolean {
  const same = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);
  return (
    prev.status === next.status &&
    same(prev.views, next.views) &&
    same(prev.likes, next.likes) &&
    same(prev.comments, next.comments) &&
    same(prev.shares, next.shares)
  );
}

/**
 * Relink latest rows orphaned by the HR delete-and-recreate resubmit (FK SetNull) to
 * the current report_links row — the same matching rule as the link_metrics re-heal
 * in social-insights.cron.ts. Returns the number of rows relinked.
 */
export async function rehealLinkMetricLatest(slug: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE link_metrics_latest m
    SET link_id = rl.id
    FROM report_links rl
    JOIN daily_reports dr ON dr.id = rl.report_id
    WHERE m.link_id IS NULL
      AND m.employee_id = dr.employee_id
      AND m.report_date = dr.date
      AND LOWER(m.platform) = ${slug}
      AND m.url_normalized = LOWER(TRIM(rl.url))
  `;
}
