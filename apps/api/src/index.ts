import "./env";
import app from "./app";
import { syncAllFollowerCounts } from "./services/follower-sync.service";
import { runSocialInsightsRefresh } from "./cron/social-insights.cron";
import { runEntityExtraction } from "./cron/entity-extraction.cron";
import { runIgCaptionBackfill } from "./cron/ig-caption-backfill.cron";

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
});
