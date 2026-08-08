import { prisma } from "@dashmani/db";
import { extractYouTubeVideoId, canonicalKey } from "@dashmani/shared";
import { getSupportedSlugs, getProvider } from "../services/social-insights";
import type { InsightTarget } from "../services/social-insights";
import { youTubeQuotaExceeded } from "../services/social-insights/youtube.provider";
import { upsertLinkContent } from "../services/link-content.service";

const POLL_WINDOW_DAYS = 60;
// Per-provider metric-sweep wall-clock budget (default 25 min). A provider yields to
// the next once this elapses AFTER its early harvest has fired — see slugDeadline use.
const SWEEP_BUDGET_MS = Number(process.env.INSIGHTS_SWEEP_BUDGET_MS) || 25 * 60 * 1000;
// The metric-sweep budget bounds the PER-LINK POLLING phase, measured from the moment
// the early harvest fires (i.e. after the one-time feed-map build). WHY separate from
// SWEEP_BUDGET_MS: for owned-feed providers (IG/FB) the map build can itself consume
// tens of minutes; if the budget clock includes it, the provider yields having polled
// almost nothing (the 2026-07-03 IG "~25-day refresh cycle" bug). Defaults to
// SWEEP_BUDGET_MS so behavior is unchanged unless explicitly tuned in prod .env.
const METRIC_BUDGET_MS = Number(process.env.INSIGHTS_METRIC_BUDGET_MS) || SWEEP_BUDGET_MS;
// A link is "fresh" if its report_date is within this many days. Fresh links are polled
// FIRST on every run, ahead of the cursor-rotated tail — see buildTieredQueue below.
const FRESH_DAYS = Number(process.env.INSIGHTS_FRESH_DAYS) || 7;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Row shape shared by every tier query and by the legacy single-queue fallback.
interface SweepRow {
  id: string;
  url: string | null;
  platform: string;
  report: { employeeId: string; date: Date };
}

// ── TIERED PRIORITY SWEEP (2026-08-08) ────────────────────────────────────────────
// WHY: the sweep used ONE `id ASC` queue + one resume cursor. `id ASC` is content-blind,
// so a 90-day queue of ~90k IG links was walked in an arbitrary fixed order under a 25-min
// budget — a full wrap took DAYS, which is exactly the measured ~21-day median metric age
// on Instagram (~6.3 days on Facebook). Links with millions of views were either missing
// from Top Links or ranked on three-week-old numbers.
//
// Measured on prod 2026-08-08: of the ~90k IG links in the window, 52,910 are OLD posts
// whose latest status is `not_found` (the documented Meta feed-window ceiling — no
// fetch-by-id, only newest-first feed paging). They occupied ~90% of the queue and were
// polled AHEAD of today's posts purely because their ids sorted first.
//
// The fix is ORDERING, not budget: same call volume, same batch size, same per-provider
// budget — just spent on the links that matter first. Three tiers:
//   A fresh      — report_date within FRESH_DAYS. Polled EVERY run, from the start, no
//                  cursor. Small and bounded (IG ~6.8k/7d, FB ~3.6k/7d), so a link posted
//                  today gets a metric on the next run instead of after a full wrap.
//   B unresolved — older, latest status is NOT ok. The coverage gap; still worth retrying.
//                  Cursor-rotated so successive runs cover the whole tail.
//   C settled    — older, latest status IS ok. Already ranked; refreshing a 60-day-old
//                  post's view count is the least valuable work available. Cursor-rotated,
//                  reached only with leftover budget.
//
// ⚠️ NOTHING IS EVER PERMANENTLY EXCLUDED. A blanket "skip not_found" blacklist was
// explicitly REJECTED after measuring recovery: links that ever returned not_found later
// returned ok for 94.4% of Facebook (12,251/12,979) and 18.2% of Instagram (12,891/70,724)
// — FB not_found is overwhelmingly a transient rate-limit/scraper wall. Blacklisting would
// have silently deleted ~24k resolvable links from the rankings. Tiers only RE-ORDER.
async function buildTieredQueue(
  slug: string,
  where: Record<string, unknown>,
  freshCutoff: Date,
): Promise<{
  rows: SweepRow[];
  tierCursorKeys: { unresolved: string; settled: string };
  tiers: Map<string, "fresh" | "unresolved" | "settled">;
}> {
  const select = {
    id: true,
    url: true,
    platform: true,
    report: { select: { employeeId: true, date: true } },
  } as const;

  const tierCursorKeys = {
    unresolved: `insights-cursor:${slug}:unresolved`,
    settled: `insights-cursor:${slug}:settled`,
  };

  // Tier A — fresh. No cursor: always polled from the start of every run.
  const fresh = await prisma.reportLink.findMany({
    where: { ...where, report: { ...(where.report as object), date: { gte: freshCutoff } } },
    orderBy: { id: "asc" },
    select,
  });

  // Older-than-fresh candidates, split by whether their LATEST snapshot resolved.
  // One indexed query for the ids whose newest metric is `ok`; everything else is
  // treated as unresolved (never polled, not_found, rate_limited, error).
  const olderWhere = {
    ...where,
    report: { ...(where.report as object), date: { lt: freshCutoff } },
  };

  const okIdRows = await prisma.$queryRaw<Array<{ link_id: string }>>`
    SELECT link_id FROM (
      SELECT DISTINCT ON (link_id) link_id, status
      FROM link_metrics
      WHERE platform = ${slug} AND link_id IS NOT NULL
      ORDER BY link_id, fetched_at DESC
    ) latest WHERE status = 'ok'
  `;
  const settledIds = new Set(okIdRows.map((r) => r.link_id));

  const [unresolvedCursor, settledCursor] = await Promise.all([
    readCursor(tierCursorKeys.unresolved),
    readCursor(tierCursorKeys.settled),
  ]);

  // Fetch the older tail once, then partition in memory. Selecting only 4 scalar
  // columns keeps this bounded (the same shape the single-queue version already
  // hydrated), so this is not a new memory cost.
  const older = await prisma.reportLink.findMany({
    where: olderWhere,
    orderBy: { id: "asc" },
    select,
  });

  const unresolved = older.filter((r) => !settledIds.has(r.id));
  const settled = older.filter((r) => settledIds.has(r.id));

  // Rotate each older tier past its own cursor, wrapping to the start when exhausted so
  // a run always finds work (mirrors the original single-cursor wrap semantics).
  const rotate = (list: SweepRow[], cursor: string): SweepRow[] => {
    if (!cursor) return list;
    const idx = list.findIndex((r) => r.id > cursor);
    return idx === -1 ? list : list.slice(idx);
  };

  const unresolvedRotated = rotate(unresolved, unresolvedCursor);
  const settledRotated = rotate(settled, settledCursor);

  // Tier membership, so the sweep can advance the CORRECT cursor per processed link
  // (ids reset downward at tier boundaries — a single monotonic cursor would be wrong).
  const tiers = new Map<string, "fresh" | "unresolved" | "settled">();
  for (const r of fresh) tiers.set(r.id, "fresh");
  for (const r of unresolvedRotated) tiers.set(r.id, "unresolved");
  for (const r of settledRotated) tiers.set(r.id, "settled");

  console.log(
    `[social-insights/${slug}] tiered queue: ${fresh.length} fresh (<${FRESH_DAYS}d) + ` +
      `${unresolvedRotated.length} unresolved + ${settledRotated.length} settled`,
  );

  return {
    rows: [...fresh, ...unresolvedRotated, ...settledRotated],
    tierCursorKeys,
    tiers,
  };
}

async function readCursor(key: string): Promise<string> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    return row?.value ?? "";
  } catch {
    return "";
  }
}

export async function runSocialInsightsRefresh(opts?: { harvestOnly?: boolean }): Promise<void> {
  const harvestOnly = opts?.harvestOnly === true;
  const startedAt = Date.now();
  const since = new Date(Date.now() - POLL_WINDOW_DAYS * 86_400_000);
  console.log(`[social-insights] starting at ${new Date().toISOString()}`);

  for (const slug of getSupportedSlugs()) {
    const provider = getProvider(slug);
    if (!provider || !provider.isSupported()) continue;

    try {
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

      // ⚠️ Route by URL HOST, not the dirty `platform` column. ~2,220 Facebook reels are
      // mislabeled platform='instagram' (and YT-under-FB etc.); routing purely by the
      // platform column sent them to the wrong provider, whose extractTargetId returns
      // null, so they got ZERO metrics (F2, 2026-06-26 audit). We instead fetch a
      // candidate set = (platform column == slug) OR (url contains a host this provider
      // owns), then let provider.extractTargetId() be the FINAL arbiter of ownership
      // (a link gets a metric only from the provider whose extractor succeeds). The
      // platform-column clause is kept so a correctly-labeled link with an odd host
      // still gets tried by its declared provider.
      const ownedHosts: Record<string, string[]> = {
        youtube: ["youtube.com", "youtu.be"],
        instagram: ["instagram.com"],
        facebook: ["facebook.com", "fb.watch", "fb.me"],
      };
      const hostClauses = (ownedHosts[slug] ?? []).map((h) => ({
        url: { contains: h, mode: "insensitive" as const },
      }));

      // ── ROTATING CURSOR (F3) ──────────────────────────────────────────────────
      // The metric sweep is wall-clock-budgeted (~25 min/provider) but a full FB pass
      // is ~80 min, so without an ordered cursor the sweep re-processed the SAME head
      // every run (only ~17% of FB links ever got a metric; 3,298 stayed frozen at a
      // pre-scraper not_found). We now order by id ASC and resume past the last id
      // processed last run, so successive runs cover the WHOLE tail and wrap around.
      const cursorKey = `insights-cursor:${slug}`;
      let cursor = "";
      try {
        const row = await prisma.systemSetting.findUnique({ where: { key: cursorKey } });
        cursor = row?.value ?? "";
      } catch { /* default to start */ }

      const baseWhere = {
        OR: [
          { platform: { equals: slug, mode: "insensitive" as const } },
          ...hostClauses,
        ],
        url: { not: null },
        isScheduled: false,
        report: { date: { gte: since } },
      };

      // Tiered priority queue (fresh → unresolved → settled). Fail-open: if the tier
      // build throws for any reason we fall back to the original single-cursor `id ASC`
      // queue, so a failure here degrades freshness but never stops the sweep.
      let tierCursorKeys: { unresolved: string; settled: string } | null = null;
      let pendingTiers: Map<string, "fresh" | "unresolved" | "settled"> | null = null;
      try {
        const freshCutoff = new Date(Date.now() - FRESH_DAYS * 86_400_000);
        const tiered = await buildTieredQueue(slug, baseWhere, freshCutoff);
        rows = tiered.rows;
        tierCursorKeys = tiered.tierCursorKeys;
        pendingTiers = tiered.tiers;
      } catch (tierErr) {
        console.error(
          `[social-insights/${slug}] tiered queue build failed — falling back to single-cursor sweep:`,
          tierErr,
        );
        try {
          rows = await prisma.reportLink.findMany({
            where: { ...baseWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" }, // deterministic order → cursor can resume
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
      }
      // If resuming past the cursor returned nothing, we've reached the end of the tail
      // → wrap: reset cursor and re-query from the start so this run still does work.
      // Legacy single-cursor wrap. Only reachable on the FALLBACK path — buildTieredQueue
      // wraps each tier internally, so when tiers are active this is a no-op.
      if (!tierCursorKeys && rows.length === 0 && cursor) {
        cursor = "";
        try {
          await prisma.systemSetting.upsert({ where: { key: cursorKey }, create: { key: cursorKey, value: "" }, update: { value: "" } });
          rows = await prisma.reportLink.findMany({
            where: {
              OR: [{ platform: { equals: slug, mode: "insensitive" } }, ...hostClauses],
              url: { not: null }, isScheduled: false, report: { date: { gte: since } },
            },
            orderBy: { id: "asc" },
            select: { id: true, url: true, platform: true, report: { select: { employeeId: true, date: true } } },
          });
        } catch (err) {
          console.error(`[social-insights/${slug}] cursor-wrap re-query failed:`, err);
        }
      }

      // 2. Extract targetId (videoId), skip links where extraction fails.
      // Cross-platform mislabeled URLs (e.g. facebook.com stored under "instagram")
      // are expected due to dirty platform data — aggregate them silently instead
      // of logging a warn per-URL.
      const targets: InsightTarget[] = [];
      let skippedCrossPlatform = 0;
      let skippedOther = 0;
      const skippedOtherExamples: string[] = [];

      // Hosts that are "expected" mislabels for each provider slug
      const crossPlatformHosts: Record<string, string[]> = {
        instagram: ["facebook.com", "fb.watch", "fb.me"],
        facebook: ["instagram.com"],
      };
      const expectedMislabelHosts = crossPlatformHosts[slug] ?? [];

      for (const row of rows) {
        if (!row.url) continue;
        const url = row.url.trim();
        const targetId = provider.extractTargetId(url);
        if (!targetId) {
          // Classify: expected cross-platform mislabel vs genuinely unexpected
          let isCrossPlatform = false;
          try {
            const host = new URL(url).hostname.replace(/^www\./, "");
            isCrossPlatform = expectedMislabelHosts.some((h) => host === h || host.endsWith("." + h));
          } catch {
            // malformed URL — treat as other
          }
          if (isCrossPlatform) {
            skippedCrossPlatform++;
          } else {
            skippedOther++;
            if (skippedOtherExamples.length < 3) skippedOtherExamples.push(url);
          }
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

      const totalSkipped = skippedCrossPlatform + skippedOther;
      if (totalSkipped > 0) {
        console.log(
          `[social-insights/${slug}] skipped ${totalSkipped} links (URL not extractable for this platform — likely cross-platform mislabel)` +
            (skippedOther > 0
              ? ` [${skippedOther} unexpected — first examples: ${skippedOtherExamples.join(", ")}]`
              : "")
        );
        if (skippedOther > 0) {
          for (const example of skippedOtherExamples) {
            console.warn(`[social-insights/${slug}] unexpected non-extractable URL: ${example}`);
          }
        }
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
      // Tracks whether the feed-map harvest has already been flushed this run.
      // The provider builds its in-memory feed map on the FIRST fetchBatch call
      // and caches it; all subsequent batches reuse the cache. We therefore
      // harvest immediately after the first SUCCESSFUL batch — this guarantees
      // that all current-feed captions reach link_content within ~80s of the
      // run starting, well before the multi-hour metric sweep over 37k links
      // completes (or is interrupted). A post-loop fallback below covers the
      // edge case where targets.length === 0 or every batch throws.
      let harvestedThisRun = false;
      // Cursor bookkeeping (F3): track the last report_link id whose metric we wrote, and
      // whether the sweep yielded early (budget) so we know to RESUME there next run vs
      // RESET to the start (full pass done). targets are id-asc, so the last is the max.
      let lastProcessedLinkId = "";
      let sweepBrokeEarly = false;
      // Per-tier high-water marks. ⚠️ Under the tiered queue the concatenated target list
      // is fresh(id-asc) → unresolved(id-asc) → settled(id-asc), so ids RESET DOWNWARD at
      // each tier boundary and a single monotonic `lastProcessedLinkId` would be wrong for
      // the older tiers (a fresh-tier id could be written as the settled cursor, rotating
      // that tier to a bogus position). Track the max processed id per tier instead.
      const tierOf = pendingTiers ?? new Map<string, "fresh" | "unresolved" | "settled">();
      const tierHighWater: Record<"unresolved" | "settled", string> = { unresolved: "", settled: "" };
      // Per-provider metric-sweep wall-clock budget. WHY: the sweep is sequential
      // across providers; a slow/rate-limited provider (e.g. Instagram's ~38k-link
      // sweep) could consume the whole run and the loop would never ADVANCE to the
      // next provider (Facebook), starving it (the 2026-06-26 "FB 0 ok" outage). Each
      // provider self-bounds: once its EARLY harvest has fired (captions safe), it
      // yields after METRIC_BUDGET_MS so every provider gets a turn within the 6h run.
      // The deadline is (re)based to now + METRIC_BUDGET_MS the moment the early harvest
      // fires — so the budget bounds the cheap per-link polling phase, NOT the one-time
      // map build that precedes it. Until then it sits far in the future so the map-build
      // batch can't trip it. The HARD backstop below (2×) still fires on Date.now() to
      // protect the never-harvests case (e.g. IG discovery returns 0 accounts → empty
      // map → harvest never fires).
      let slugDeadline = Number.MAX_SAFE_INTEGER;
      const runStartedForSlug = Date.now();

      if (harvestOnly) {
        console.log(
          `[social-insights/${slug}] harvestOnly — skipping metric sweep (${targets.length} links), harvest only`
        );
      }

      for (const batch of chunk(targets, 50)) {
        try {
          const results = await provider.fetchBatch(batch);

          // Check if quota exceeded mid-run. SCOPED to YouTube: youTubeQuotaExceeded is
          // a module-level flag that is never reset, so reading it for IG/FB would let a
          // YT-quota day suppress the NEXT provider's harvest. IG/FB have their own
          // igRateLimited/fbRateLimited; this cross-provider read was always wrong.
          if (slug === "youtube" && youTubeQuotaExceeded) {
            quotaAborted = true;
            // Mark remaining in batch as rate_limited
            for (const t of batch) {
              if (!results.has(t.linkId)) {
                results.set(t.linkId, { ok: false, status: "rate_limited", error: "quota exceeded" });
              }
            }
          }

          // Write snapshots + per-link content enrichment (skipped in harvestOnly mode)
          if (!harvestOnly) {
            for (const t of batch) {
              const r = results.get(t.linkId);
              if (!r) continue;
              polled++;
              lastProcessedLinkId = t.linkId; // fallback path: targets are id-asc
              // Tiered path: advance THIS link's own tier high-water mark. Fresh links
              // have no cursor (always re-polled from the start), so they're skipped.
              const tier = tierOf.get(t.linkId);
              if (tier === "unresolved" || tier === "settled") {
                if (t.linkId > tierHighWater[tier]) tierHighWater[tier] = t.linkId;
              }

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
          }

          // ── Early harvest: flush the full feed-map right after the first successful
          //    batch (the map is now cached; no extra API calls needed). Independently
          //    guarded so a harvest failure NEVER affects the metric writes above.
          if (!harvestedThisRun && typeof provider.harvestContent === "function" && !quotaAborted) {
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
              console.log(`[social-insights/${slug}] harvested ${harvestWritten}/${harvested.length} feed-map captions → link_content (early, after first batch)`);
              // Only consider the run harvested if the feed map actually had content.
              // An EMPTY map means buildShortcodeMap()/buildPostMap() transiently failed
              // on this batch (fetchBatch swallows the build error and returns an all-error
              // result without re-throwing, leaving lastBuiltMap empty). Leaving the flag
              // false lets a later batch — whose build may succeed — or the post-loop
              // fallback retry the harvest, instead of locking in the empty map.
              if (harvested.length > 0) {
                harvestedThisRun = true;
                // Rebase the metric-sweep budget to start NOW — the map is built + cached,
                // so the remaining batches are cheap map lookups. This is the fix for the
                // IG "map build eats the whole budget → ~1 batch polled" starvation.
                slugDeadline = Date.now() + METRIC_BUDGET_MS;
              }
            } catch (harvestErr) {
              // Log but don't set harvestedThisRun — the post-loop fallback will retry
              console.error(`[social-insights/${slug}] early harvestContent failed (metrics unaffected):`, harvestErr);
            }
          }

          if (quotaAborted) break;
          // In harvestOnly mode: once the early harvest has fired (feed map populated +
          // captions written), stop grinding through the remaining metric batches.
          // The post-loop fallback below will not re-run (harvestedThisRun is true).
          if (harvestOnly && harvestedThisRun) break;
          // Per-provider budget: once THIS provider's early harvest has fired AND its
          // wall-clock budget is spent, yield so the loop ADVANCES to the next provider
          // (prevents one slow provider from starving the rest — captions are already
          // safe via the early harvest, only the per-link metric tail is cut short).
          if (harvestedThisRun && Date.now() > slugDeadline) {
            console.log(
              `[social-insights/${slug}] metric-sweep budget (${METRIC_BUDGET_MS}ms) spent after harvest — yielding to next provider`
            );
            sweepBrokeEarly = true;
            break;
          }
          // HARD backstop: if the early harvest NEVER fired (e.g. IG discovery returned
          // 0 accounts → empty map → harvestedThisRun stays false), slugDeadline is still
          // MAX_SAFE_INTEGER, so the soft break above can't trigger and the loop would
          // grind every batch, starving later providers (the exact IG-0-accounts →
          // FB-starved failure mode). Bound the whole provider (map-build + polling) at
          // 2× METRIC_BUDGET_MS from run start — a non-harvesting provider has nothing to
          // flush anyway, so yielding costs nothing.
          if (Date.now() > runStartedForSlug + 2 * METRIC_BUDGET_MS) {
            console.warn(
              `[social-insights/${slug}] metric-sweep HARD budget (${2 * METRIC_BUDGET_MS}ms) spent (harvest fired=${harvestedThisRun}) — yielding to next provider`
            );
            sweepBrokeEarly = true;
            break;
          }
        } catch (batchErr) {
          console.error(`[social-insights/${slug}] batch failed:`, batchErr);
          errors += batch.length;
        }
      }

      if (!harvestOnly) {
        console.log(
          `[social-insights/${slug}] ${targets.length} links → ${polled} polled, ${succeeded} ok, ${notFound} not_found, ${errors} errors${quotaAborted ? " (QUOTA ABORTED)" : ""}`
        );
        // (Cost Sheet usage is now recorded at the TRUE chokepoints — graphFetch for
        // ALL Meta calls, the YouTube fetch helpers for YouTube — so EVERY caller is
        // counted, not just this cron. The old per-cron aggregate was removed to avoid
        // double-counting the Meta calls graphFetch now records itself.)
        // Persist the rotating cursor (F3): if the sweep yielded early, RESUME after the
        // last processed link next run; if it ran to completion, RESET so the next run
        // wraps to the start (a fresh full pass). harvestOnly runs never touch the cursor.
        try {
          if (tierCursorKeys) {
            // Tiered path: persist EACH older tier's own high-water mark. A tier that was
            // reached and yielded early RESUMES after its last processed id; a tier that
            // ran to completion (or was never reached because the budget was spent on a
            // higher tier) RESETS to "" so the next run starts it from the top. Fresh has
            // no cursor by design — it is always re-polled from the start.
            for (const tier of ["unresolved", "settled"] as const) {
              const next = sweepBrokeEarly && tierHighWater[tier] ? tierHighWater[tier] : "";
              const key = tierCursorKeys[tier];
              await prisma.systemSetting.upsert({
                where: { key },
                create: { key, value: next },
                update: { value: next },
              });
            }
          } else {
            const nextCursor = sweepBrokeEarly && lastProcessedLinkId ? lastProcessedLinkId : "";
            await prisma.systemSetting.upsert({
              where: { key: cursorKey },
              create: { key: cursorKey, value: nextCursor },
              update: { value: nextCursor },
            });
          }
        } catch (cursorErr) {
          console.error(`[social-insights/${slug}] failed to persist cursor:`, cursorErr);
        }
      }

      // 3b. Harvest fallback: runs only if the early harvest above was never reached
      //     (e.g. targets.length === 0, every batch threw, or early harvest itself
      //     threw). Covers the owned-account feed providers (Instagram, Facebook) that
      //     expose every post seen this run — not just matched submitted links.
      //     No extra API calls — reuses the map fetchBatch already built.
      //     A failure here can NEVER affect the metric snapshots written above.
      if (!harvestedThisRun && typeof provider.harvestContent === "function" && !quotaAborted) {
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
          console.log(`[social-insights/${slug}] harvested ${harvestWritten}/${harvested.length} feed-map captions → link_content (fallback)`);
          harvestedThisRun = true;
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
    } catch (slugErr) {
      console.error(`[social-insights/${slug}] run failed (continuing to next provider):`, slugErr);
    }
  }

  console.log(`[social-insights] done in ${Date.now() - startedAt}ms`);
}
