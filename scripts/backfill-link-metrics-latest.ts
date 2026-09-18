/**
 * backfill-link-metrics-latest.ts — seed `link_metrics_latest` (the engagement READ
 * model, 2026-09-18) from the `link_metrics` snapshot log.
 *
 * For every (employee_id, url_normalized) that has at least one status='ok' snapshot,
 * copy the NEWEST such snapshot into link_metrics_latest. Chunked per employee so each
 * chunk is one bounded range of the covering index, with a LATERAL join-back so only
 * the winning snapshot's heap row is read. Idempotent — `ON CONFLICT … WHERE
 * EXCLUDED.fetched_at > link_metrics_latest.fetched_at` means re-running is safe and
 * so is running while the live cron upserts concurrently (newer wins either way).
 *
 * Was run on prod 2026-09-18 12:52Z–12:57Z (as an equivalent bash/psql loop before
 * this file existed in the checkout): 110,418 rows across 112 users, ~1s per chunk.
 *
 * Usage (from packages/db so Prisma loads that .env):
 *   cd packages/db && npx tsx ../../scripts/backfill-link-metrics-latest.ts                # dry run: counts only
 *   cd packages/db && npx tsx ../../scripts/backfill-link-metrics-latest.ts --apply         # local/dev
 *   cd packages/db && npx tsx ../../scripts/backfill-link-metrics-latest.ts --apply --confirm-prod
 */
import { prisma } from "@dashmani/db";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");
const PAUSE_MS = 1000;

const dbUrl = process.env.DATABASE_URL ?? "";
const looksProd = /dashmani_prod|172\.105\.53\.101|digitalsukoon/.test(dbUrl);
if (APPLY && looksProd && !CONFIRM_PROD) {
  console.error("Refusing --apply against what looks like PRODUCTION without --confirm-prod.");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const users = await prisma.user.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${users.length} employees to scan`);
  let total = 0;
  for (const { id } of users) {
    const t0 = Date.now();
    let n: number;
    if (APPLY) {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        WITH w AS (
          SELECT DISTINCT ON (employee_id, url_normalized) employee_id, url_normalized, fetched_at
          FROM link_metrics
          WHERE status = 'ok' AND employee_id = ${id}
          ORDER BY employee_id, url_normalized, fetched_at DESC
        ), ins AS (
          INSERT INTO link_metrics_latest
            (employee_id, url_normalized, link_id, report_date, url, platform, video_id,
             fetched_at, views, likes, comments, shares)
          SELECT f.employee_id, f.url_normalized, f.link_id, f.report_date, f.url, f.platform,
                 f.video_id, f.fetched_at, f.views, f.likes, f.comments, f.shares
          FROM w
          JOIN LATERAL (
            SELECT lm.employee_id, lm.url_normalized, lm.link_id, lm.report_date, lm.url,
                   lm.platform, lm.video_id, lm.fetched_at, lm.views, lm.likes, lm.comments, lm.shares
            FROM link_metrics lm
            WHERE lm.employee_id = w.employee_id
              AND lm.url_normalized = w.url_normalized
              AND lm.status = 'ok'
            ORDER BY lm.fetched_at DESC
            LIMIT 1
          ) f ON true
          ON CONFLICT (employee_id, url_normalized) DO UPDATE SET
            link_id = EXCLUDED.link_id, report_date = EXCLUDED.report_date, url = EXCLUDED.url,
            platform = EXCLUDED.platform, video_id = EXCLUDED.video_id, fetched_at = EXCLUDED.fetched_at,
            views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments, shares = EXCLUDED.shares
          WHERE EXCLUDED.fetched_at > link_metrics_latest.fetched_at
          RETURNING 1
        )
        SELECT count(*)::bigint AS n FROM ins
      `;
      n = Number(rows[0]?.n ?? 0);
    } else {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM (
          SELECT DISTINCT ON (employee_id, url_normalized) employee_id
          FROM link_metrics
          WHERE status = 'ok' AND employee_id = ${id}
          ORDER BY employee_id, url_normalized, fetched_at DESC
        ) w
      `;
      n = Number(rows[0]?.n ?? 0);
    }
    total += n;
    if (n > 0) console.log(`emp=${id} ${APPLY ? "written" : "would write"}=${n} took=${Date.now() - t0}ms`);
    await sleep(PAUSE_MS);
  }
  const have = await prisma.linkMetricLatest.count();
  console.log(`done: ${APPLY ? "written" : "would write"}=${total}; link_metrics_latest now holds ${have} rows`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
