import "./env";
import app from "./app";
import { syncAllFollowerCounts } from "./services/follower-sync.service";
import { runMetaPostsSync } from "./services/meta-oauth/meta-posts.service";
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

  // Run social insights refresh once on startup, then on INSIGHTS_INTERVAL_MS (default
  // 6h, unchanged). Prod raises cadence via .env (e.g. 2h) to shrink the IG/FB per-link
  // refresh latency — the metric sweep is cursor-based, so more runs cover more of the
  // ~35k IG / ~11k FB tail per day. Bounded ≥2h in practice to stay under the shared
  // ~200-call/hr Meta budget (follower-sync + ig-caption-backfill also draw from it) and
  // to keep the Facebook public-reel scraper polite. See the 2026-07-03 freshness plan.
  const INSIGHTS_INTERVAL_MS = Number(process.env.INSIGHTS_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  const runInsights = () => {
    runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
  };
  runInsights();
  setInterval(runInsights, INSIGHTS_INTERVAL_MS);

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
    runMetaPostsSync().catch((err) =>
      console.error("[meta-posts] error:", scrubSecrets(String(err))),
    );
  };
  setTimeout(
    () => {
      runMetaPosts();
      setInterval(runMetaPosts, metaTuning.postsIntervalMs());
    },
    12 * 60 * 1000,
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
