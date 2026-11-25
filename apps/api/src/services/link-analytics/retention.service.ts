// Link Analytics — retention (docs/link-analytics/SPEC.md §7). The prod disk filled on 2026-10-25
// because link_metrics appended a row per poll forever; this feature's tables never grow unbounded:
//   1. archived batches are deleted 30 days after archiving (items cascade);
//   2. posts no batch refers to any more are deleted (snapshots cascade);
//   3. snapshots older than 30 days are thinned to the LAST check per post per IST day, and the
//      FIRST snapshot of every post is always kept (growth "from first check" stays true).
// Runs once per IST day at 04:40, never at boot. Idempotent; a re-run is a no-op.

import { prisma } from "@dashmani/db";

export const RETENTION = {
  archivedBatchDays: 30,
  snapshotFullDays: 30,
  orphanPostGraceHours: 24,
};

export async function runLinkAnalyticsRetention(now = new Date()) {
  const archivedCutoff = new Date(now.getTime() - RETENTION.archivedBatchDays * 86400_000);
  const batches = await prisma.linkBatch.deleteMany({ where: { archivedAt: { lt: archivedCutoff } } });

  const orphanCutoff = new Date(now.getTime() - RETENTION.orphanPostGraceHours * 3600_000);
  const posts = await prisma.$executeRaw`
    DELETE FROM link_posts p
     WHERE p.created_at < ${orphanCutoff}
       AND NOT EXISTS (SELECT 1 FROM link_batch_items i WHERE i.post_id = p.id)`;

  const snapCutoff = new Date(now.getTime() - RETENTION.snapshotFullDays * 86400_000);
  const snapshots = await prisma.$executeRaw`
    DELETE FROM link_post_snapshots s USING (
      SELECT id,
             row_number() OVER (PARTITION BY post_id, ((checked_at + interval '330 minutes')::date) ORDER BY checked_at DESC) AS day_rank,
             (checked_at = min(checked_at) OVER (PARTITION BY post_id)) AS is_first
        FROM link_post_snapshots
       WHERE post_id IN (SELECT DISTINCT post_id FROM link_post_snapshots WHERE checked_at < ${snapCutoff})
    ) x
     WHERE s.id = x.id AND s.checked_at < ${snapCutoff} AND x.day_rank > 1 AND NOT x.is_first`;

  return { batchesDeleted: batches.count, postsDeleted: Number(posts), snapshotsThinned: Number(snapshots) };
}

let lastRunDay: string | null = null;

/** Hourly check; runs in the 04:xx IST hour once per IST day (after 04:40 so it trails the 04:20 api_usage rollup). */
export function scheduleLinkAnalyticsRetention(): void {
  if (process.env.LINK_ANALYTICS_RETENTION === "0") return;
  const check = async () => {
    const ist = new Date(Date.now() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    if (ist.getUTCHours() !== 4 || ist.getUTCMinutes() < 40 || lastRunDay === day) return;
    lastRunDay = day;
    try {
      const r = await runLinkAnalyticsRetention();
      console.log(`[link-analytics] retention: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error("[link-analytics] retention failed:", String(e).slice(0, 300));
    }
  };
  setInterval(check, 10 * 60_000).unref?.();
}
