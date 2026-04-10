import { syncAllFollowerCounts } from "../services/follower-sync.service";

async function main() {
  console.log(`[follower-sync] Starting at ${new Date().toISOString()}`);
  const results = await syncAllFollowerCounts();
  console.log(`[follower-sync] Done:`, results);
  process.exit(0);
}

main().catch((err) => {
  console.error("[follower-sync] Fatal error:", err);
  process.exit(1);
});
