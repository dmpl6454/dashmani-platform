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
      views: number | null;
      likes: number | null;
      comments: number | null;
      shares: number | null;
    }>
  >`
    SELECT DISTINCT ON (link_id) link_id, status, views, likes, comments, shares
    FROM link_metrics
    WHERE link_id = ANY(${linkIds}::text[])
    ORDER BY link_id, fetched_at DESC
  `;
  for (const r of rows) {
    out.set(r.link_id, {
      status: r.status,
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
