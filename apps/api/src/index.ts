import "./env";
import app from "./app";
import { syncAllFollowerCounts } from "./services/follower-sync.service";
import { runMetaPostsSync } from "./services/meta-oauth/meta-posts.service";
import { runMetaChannelSync } from "./services/meta-oauth/meta-channels.service";
import { runMetaDemographicsSync } from "./services/meta-oauth/meta-demographics.service";
import { metaOauthConfigured, metaTuning } from "./services/meta-oauth/meta-config";
import { scrubSecrets } from "./utils/token-crypto";
import { runSocialInsightsRefresh } from "./cron/social-insights.cron";
import { runEntityExtraction } from "./cron/entity-extraction.cron";
import { runIgCaptionBackfill } from "./cron/ig-caption-backfill.cron";
import { runMetaTokenHealth } from "./cron/meta-token-health.cron";

// ── Process-level crash backstops (defense-in-depth) ────────────────────────────
// The 2026-07-08 outage was an unhandled promise rejection (a P2024 pool timeout in an
// unguarded async middleware) that crash-looped the process for hours. Task 2's
// asyncHandler fixes the known surface; these handlers are the NET so a FUTURE unguarded
// `await` logs loudly instead of silently killing the box under load. We deliberately do
// NOT process.exit() here — an operational DB blip should degrade to logged 500s, not a
// restart storm. (A truly corrupt process state is vanishingly rare vs. the pool-timeout
// case this incident proved; pm2 still restarts on a real hard crash.)
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] (kept alive — see incident 2026-07-08):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] (kept alive — see incident 2026-07-08):", err);
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);

  // Run follower sync once on startup, then every hour
  const runFollowerSync = () => {
    syncAllFollowerCounts().catch((err) => console.error("[follower-sync] error:", err));
  };
  runFollowerSync();
  setInterval(runFollowerSync, 60 * 60 * 1000);

  // Run social insights refresh after a BOOT DELAY, then on INSIGHTS_INTERVAL_MS (default
  // 6h). Prod raises cadence via .env (e.g. 2h) to shrink the IG/FB per-link refresh
  // latency — the metric sweep is cursor-based, so more runs cover more of the ~35k IG /
  // ~11k FB tail per day. Bounded ≥2h in practice to stay under the shared ~200-call/hr
  // Meta budget (follower-sync + ig-caption-backfill also draw from it) and to keep the
  // Facebook public-reel scraper polite. See the 2026-07-03 freshness plan.
  //
  // ⚠️ 2026-09-08 incident: the sweep used to start IMMEDIATELY on boot. A pathological
  // provider batch then pinned the main thread within ~4 minutes of EVERY restart, so a
  // restart could not restore service — the tier cursors persist only after a provider
  // completes, so each boot replayed the identical poison queue. Three guards now:
  //   1. INSIGHTS_BOOT_DELAY_MS (default 10 min) guarantees every restart a window of a
  //      responsive API before the sweep touches a provider.
  //   2. INSIGHTS_ENABLED=0 is a real operator kill switch. Before this the only way to
  //      stop the sweep was to unset META_SYSTEM_USER_TOKEN / YOUTUBE_API_KEY, which also
  //      disables follower-sync and the IG caption backfill.
  //   3. The interval is clamped to Node's setInterval ceiling (2^31-1 ms). Above it Node
  //      coerces the delay to 1 ms — a "lengthen the interval" edit would become a
  //      1 ms sweep storm.
  // runSocialInsightsRefresh() itself also refuses to overlap a still-running sweep (see
  // the cron) — a 2h timer used to stack sweeps on top of one another indefinitely.
  const INSIGHTS_ENABLED = process.env.INSIGHTS_ENABLED !== "0";
  const MAX_TIMER_MS = 2_147_483_647;
  let INSIGHTS_INTERVAL_MS = Number(process.env.INSIGHTS_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  if (INSIGHTS_INTERVAL_MS > MAX_TIMER_MS) {
    console.warn(
      `[social-insights] INSIGHTS_INTERVAL_MS=${INSIGHTS_INTERVAL_MS} exceeds the setInterval ceiling — clamping to ${MAX_TIMER_MS}ms`
    );
    INSIGHTS_INTERVAL_MS = MAX_TIMER_MS;
  }
  const bootDelayRaw = process.env.INSIGHTS_BOOT_DELAY_MS;
  const INSIGHTS_BOOT_DELAY_MS =
    bootDelayRaw !== undefined && bootDelayRaw !== "" && Number.isFinite(Number(bootDelayRaw)) && Number(bootDelayRaw) >= 0
      ? Math.min(Number(bootDelayRaw), MAX_TIMER_MS)
      : 10 * 60 * 1000;
  if (!INSIGHTS_ENABLED) {
    console.warn("[social-insights] DISABLED via INSIGHTS_ENABLED=0 — the metric sweep will not run in this process");
  } else {
    const runInsights = () => {
      runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
    };
    console.log(
      `[social-insights] first sweep in ${Math.round(INSIGHTS_BOOT_DELAY_MS / 60_000)} min, then every ${Math.round(INSIGHTS_INTERVAL_MS / 60_000)} min`
    );
    setTimeout(() => {
      runInsights();
      setInterval(runInsights, INSIGHTS_INTERVAL_MS);
    }, INSIGHTS_BOOT_DELAY_MS);
  }

  // Run entity extraction once on startup, then HOURLY (independent of insights).
  // Hourly (was 6h) gives ~12,000 captions/day of tagging throughput — enough to keep
  // up with the ~1.7k/day new IG+FB caption inflow AND drain a backlog. (The 2026-06-26
  // incident left ~25k captions pending after the extraction outage + heal.)
  const runExtraction = () => {
    runEntityExtraction().catch((err) => console.error("[entity-extraction] error:", err));
  };
  runExtraction();
  setInterval(runExtraction, 60 * 60 * 1000);

  // IG caption backfill — spaced waves, HOURLY. Closes the historical IG-caption
  // gap (external accounts business_discovery can read but the owned-harvest can't)
  // a few accounts per hour, self-throttling under Meta's (#4) rate limit. Idles
  // once the gap is covered (~1-2 days). DARK without META_SYSTEM_USER_TOKEN.
  // First run delayed 5 min so it doesn't fire at the same instant as the startup
  // follower-sync + social-insights runs (all share the ~200-call/hr Meta budget).
  const runIgBackfill = () => {
    runIgCaptionBackfill().catch((err) => console.error("[ig-caption-backfill] error:", err));
  };
  setTimeout(() => {
    runIgBackfill();
    setInterval(runIgBackfill, 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Meta OAuth posts sync — DARK unless the five META_OAUTH_* vars are set AND at
  // least one connection exists, so this is a no-op on any box without a connection.
  //
  // First run offset 12 min so it never coincides with the startup follower-sync,
  // social-insights or ig-caption-backfill bursts. Those all draw on the OLD app's
  // ~200-call/hr Meta budget; this uses the NEW app's separate budget, but the box
  // itself is 1 vCPU and staggering keeps CPU/pool contention low.
  const runMetaPosts = () => {
    if (!metaOauthConfigured()) return;
    // CHANNEL metrics first — they are the headline data on Account Growth and cost
    // ~1 call each, so they must never be starved by the far more expensive
    // per-post pass that follows.
    //
    // ⚠️ ONE RETRY, on a THROWN error only. runMetaChannelSync resolves normally
    // for every EXPECTED outcome (rate limit, per-asset failure, budget spent), so
    // a rejection means infrastructure — and the one we have actually seen is
    // Postgres being bounced underneath the run. On 2026-09-11 unattended-upgrades
    // installed a libc6 security update at 06:33:55 and needrestart stopped
    // postgresql@16-main at 06:34:56; an in-flight write threw "Server has closed
    // the connection" and the whole sweep died at asset 116 of 318, leaving
    // two-thirds of the estate on yesterday's figures until the next tick 3h later.
    // Postgres was back in 4 seconds. That upgrade job runs DAILY, and the sweep
    // occupies ~17% of the clock, so this recurs on its own.
    //
    // The retry resumes where the run stopped for free: the sync orders assets by
    // metricsFetchedAt asc NULLS FIRST, so the ones it never reached are precisely
    // the stalest and therefore first in line. It costs nothing when nothing throws,
    // and if the database is genuinely down the retry fails fast on its first query
    // rather than burning Meta calls it cannot store.
    runMetaChannelSync()
      .catch(async (err) => {
        console.error(
          "[meta-sync] channel sync threw — retrying once in 60s:",
          scrubSecrets(String(err)),
        );
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return runMetaChannelSync();
      })
      .then(() => runMetaPostsSync())
      .catch((err) => console.error("[meta-sync] error:", scrubSecrets(String(err))));
  };
  setTimeout(
    () => {
      runMetaPosts();
      setInterval(runMetaPosts, metaTuning.postsIntervalMs());
    },
    12 * 60 * 1000,
  );

  // Instagram audience demographics — DAILY, deliberately separate from the
  // 3-hourly sync above. A full pass is ~576 calls and would nearly double that
  // sync's 672, starving the headline metrics. Demographics move slowly, and the
  // service rotates least-recently-fetched first so coverage completes across
  // runs. Offset 40 min so it never lands on the same tick as the channel sync.
  const runMetaDemographics = () => {
    if (!metaOauthConfigured()) return;
    runMetaDemographicsSync().catch((err) =>
      console.error("[meta-demographics] error:", scrubSecrets(String(err))),
    );
  };
  setTimeout(
    () => {
      runMetaDemographics();
      setInterval(runMetaDemographics, 24 * 60 * 60 * 1000);
    },
    40 * 60 * 1000,
  );

  // Meta token health — DAILY, and DB-only unless a grant is actually near expiry.
  // Meta's data_access_expires_at (~90d) is the clock that matters: when it lapses,
  // reads just start failing. Without this the first symptom would be a page that
  // quietly stops updating — the silent-decay class this codebase keeps getting bitten
  // by. Offset 20 min to stay clear of every other startup burst.
  const runTokenHealth = () => {
    if (!metaOauthConfigured()) return;
    runMetaTokenHealth().catch((err) =>
      console.error("[meta-token-health] error:", scrubSecrets(String(err))),
    );
  };
  setTimeout(
    () => {
      runTokenHealth();
      setInterval(runTokenHealth, 24 * 60 * 60 * 1000);
    },
    20 * 60 * 1000,
  );
});
