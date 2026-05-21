import "./env";
import app from "./app";
import { syncAllFollowerCounts } from "./services/follower-sync.service";

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);

  // Run follower sync once on startup, then every hour
  const runFollowerSync = () => {
    syncAllFollowerCounts().catch((err) => console.error("[follower-sync] error:", err));
  };
  runFollowerSync();
  setInterval(runFollowerSync, 60 * 60 * 1000);
});
