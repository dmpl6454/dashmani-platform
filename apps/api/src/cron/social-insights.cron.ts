import { prisma } from "@dashmani/db";
import { extractYouTubeVideoId, canonicalKey } from "@dashmani/shared";
import { getSupportedSlugs, getProvider } from "../services/social-insights";
import type { InsightTarget } from "../services/social-insights";
import { youTubeQuotaExceeded } from "../services/social-insights/youtube.provider";
import { upsertLinkContent } from "../services/link-content.service";

const POLL_WINDOW_DAYS = 60;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export async function runSocialInsightsRefresh(): Promise<void> {
  const startedAt = Date.now();
  const since = new Date(Date.now() - POLL_WINDOW_DAYS * 86_400_000);
  console.log(`[social-insights] starting at ${new Date().toISOString()}`);

  for (const slug of getSupportedSlugs()) {
    const provider = getProvider(slug);
    if (!provider || !provider.isSupported()) continue;

    // Reset quota flag at the start of each run (per-provider)
    // (youTubeQuotaExceeded is module-level; if it's true from a prior run, we still try
    //  since quota resets daily — worst case we hit quota again and abort cleanly)

    // 1. Fetch all links for this platform submitted within the polling window
    let rows: Array<{
      id: string;
      url: string | null;
      platform: string;
      report: { employeeId: string; date: Date };
    }>;

    try {
      rows = await prisma.reportLink.findMany({
        where: {
          platform: { equals: slug, mode: "insensitive" },
          url: { not: null },
          isScheduled: false,
          report: { date: { gte: since } },
        },
        select: {
          id: true,
          url: true,
          platform: true,
          report: { select: { employeeId: true, date: true } },
        },
      });
    } catch (err) {
      console.error(`[social-insights/${slug}] failed to query links:`, err);
      continue;
    }

    // 2. Extract targetId (videoId), skip links where extraction fails
    const targets: InsightTarget[] = [];
    for (const row of rows) {
      if (!row.url) continue;
      const url = row.url.trim();
      const targetId = provider.extractTargetId(url);
      if (!targetId) {
        console.warn(`[social-insights/${slug}] could not extract targetId from: ${url}`);
        continue;
      }
      targets.push({
        linkId: row.id,
        url,
        urlNormalized: url.toLowerCase(),
        targetId,
        employeeId: row.report.employeeId,
        reportDate: row.report.date,
      });
    }

    if (targets.length === 0) {
      console.log(`[social-insights/${slug}] no links to poll`);
      continue;
    }

    // 3. Batch, fetch, write snapshots
    let polled = 0;
    let succeeded = 0;
    let notFound = 0;
    let errors = 0;
    let quotaAborted = false;

    for (const batch of chunk(targets, 50)) {
      try {
        const results = await provider.fetchBatch(batch);

        // Check if quota exceeded mid-run
        if (youTubeQuotaExceeded) {
          quotaAborted = true;
          // Mark remaining in batch as rate_limited
          for (const t of batch) {
            if (!results.has(t.linkId)) {
              results.set(t.linkId, { ok: false, status: "rate_limited", error: "quota exceeded" });
            }
          }
        }

        // Write snapshots
        for (const t of batch) {
          const r = results.get(t.linkId);
          if (!r) continue;
          polled++;

          try {
            await prisma.linkMetric.create({
              data: {
                linkId: t.linkId,
                employeeId: t.employeeId,
                reportDate: t.reportDate,
                url: t.url,
                urlNormalized: t.urlNormalized,
                platform: slug,
                videoId: slug === "youtube" ? extractYouTubeVideoId(t.url) : null,
                status: r.status,
                views: r.views ?? null,
                likes: r.likes ?? null,
                comments: r.comments ?? null,
                shares: r.shares ?? null,
                errorMessage: r.error ?? null,
              },
            });

            if (r.status === "ok") succeeded++;
            else if (r.status === "not_found") notFound++;
            else errors++;
          } catch (writeErr) {
            console.error(`[social-insights/${slug}] failed to write snapshot for linkId ${t.linkId}:`, writeErr);
            errors++;
          }

          // ── Link-content enrichment (ADDITIVE) ─────────────────────────────
          // Store caption/title for the entity-search feature, keyed on the post's
          // canonicalKey (one row per unique post). Independently guarded: a failure
          // here must NEVER affect the metric snapshot written above. Only writes when
          // the provider returned text (title/caption); skipped otherwise.
          if (r.ok && (r.title != null || r.caption != null)) {
            try {
              const key = canonicalKey(t.url);
              if (key) {
                await upsertLinkContent({
                  canonicalKey: key,
                  title: r.title ?? null,
                  caption: r.caption ?? null,
                  status: "ok",
                });
              }
            } catch (contentErr) {
              console.error(`[social-insights/${slug}] link-content upsert failed for linkId ${t.linkId}:`, contentErr);
              // swallow — never affects metrics or counters
            }
          }
        }

        if (quotaAborted) break;
      } catch (batchErr) {
        console.error(`[social-insights/${slug}] batch failed:`, batchErr);
        errors += batch.length;
      }
    }

    console.log(
      `[social-insights/${slug}] ${targets.length} links → ${polled} polled, ${succeeded} ok, ${notFound} not_found, ${errors} errors${quotaAborted ? " (QUOTA ABORTED)" : ""}`
    );

    // 3b. Harvest the FULL feed map for content enrichment (ADDITIVE, independently
    //     guarded). Providers that page an owned-account feed (Instagram) expose
    //     EVERY post they saw this run — not just submitted links still top-of-feed.
    //     This is what keeps IG content enrichment ahead of firehose volume: a
    //     post's caption is captured at fetch time, keyed by canonicalKey, so a
    //     later-matched report_link finds it even after it's buried in the feed.
    //     A failure here can NEVER affect the metric snapshots written above.
    //     No extra API calls — reuses the map fetchBatch just built.
    if (typeof provider.harvestContent === "function" && !quotaAborted) {
      try {
        const harvested = provider.harvestContent();
        let harvestWritten = 0;
        for (const h of harvested) {
          if (!h.canonicalKey || (h.title == null && h.caption == null)) continue;
          try {
            await upsertLinkContent({
              canonicalKey: h.canonicalKey,
              title: h.title ?? null,
              caption: h.caption ?? null,
              status: "ok",
            });
            harvestWritten++;
          } catch (oneErr) {
            // swallow per-row — never affects metrics or the rest of the harvest
            console.error(`[social-insights/${slug}] harvest upsert failed for ${h.canonicalKey}:`, oneErr);
          }
        }
        if (harvested.length > 0) {
          console.log(`[social-insights/${slug}] harvested ${harvestWritten}/${harvested.length} feed-map captions → link_content`);
        }
      } catch (harvestErr) {
        console.error(`[social-insights/${slug}] harvestContent failed (metrics unaffected):`, harvestErr);
      }
    }

    // 4. Re-heal: re-link orphaned snapshots (linkId=null) back to current ReportLink rows
    //    This fires after every poll run to restore FKs broken by delete-and-recreate resubmits.
    try {
      await prisma.$executeRaw`
        UPDATE link_metrics m
        SET link_id = rl.id
        FROM report_links rl
        JOIN daily_reports dr ON dr.id = rl.report_id
        WHERE m.link_id IS NULL
          AND m.employee_id = dr.employee_id
          AND m.report_date = dr.date
          AND LOWER(m.platform) = ${slug}
          AND m.url_normalized = LOWER(TRIM(rl.url))
      `;
    } catch (healErr) {
      console.error(`[social-insights/${slug}] re-heal query failed:`, healErr);
    }
  }

  console.log(`[social-insights] done in ${Date.now() - startedAt}ms`);
}
