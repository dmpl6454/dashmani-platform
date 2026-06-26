import "./env";
import app from "./app";
import { syncAllFollowerCounts } from "./services/follower-sync.service";
import { runSocialInsightsRefresh } from "./cron/social-insights.cron";
import { runEntityExtraction } from "./cron/entity-extraction.cron";

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);

  // Run follower sync once on startup, then every hour
  const runFollowerSync = () => {
    syncAllFollowerCounts().catch((err) => console.error("[follower-sync] error:", err));
  };
  runFollowerSync();
  setInterval(runFollowerSync, 60 * 60 * 1000);

  // Run social insights refresh once on startup, then every 6 hours
  const runInsights = () => {
    runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
  };
  runInsights();
  setInterval(runInsights, 6 * 60 * 60 * 1000);

  // Run entity extraction once on startup, then HOURLY (independent of insights).
  // Hourly (was 6h) gives ~12,000 captions/day of tagging throughput — enough to keep
  // up with the ~1.7k/day new IG+FB caption inflow AND drain a backlog. (The 2026-06-26
  // incident left ~25k captions pending after the extraction outage + heal.)
  const runExtraction = () => {
    runEntityExtraction().catch((err) => console.error("[entity-extraction] error:", err));
  };
  runExtraction();
  setInterval(runExtraction, 60 * 60 * 1000);
});
