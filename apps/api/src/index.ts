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

  // Run entity extraction once on startup, then every 6 hours (independent of insights).
  const runExtraction = () => {
    runEntityExtraction().catch((err) => console.error("[entity-extraction] error:", err));
  };
  runExtraction();
  setInterval(runExtraction, 6 * 60 * 60 * 1000);
});
