import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

// Load .env from monorepo root
const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      // Set to 0 so the DELAY_MS sleep() calls in follower-sync.service.ts
      // resolve immediately in tests, avoiding 5s-per-account delays.
      FOLLOWER_SYNC_DELAY_MS: "0",
      // Set to 0 so the 429/401 rate-limit backoff in the IG scraper resolves
      // immediately in tests, avoiding the 30s retry wait.
      FOLLOWER_SYNC_BACKOFF_MS: "0",
      // Disable the Facebook public-reel scraper fallback by default in tests so the
      // FB provider's not_found path never touches the real www.facebook.com. The
      // dedicated fallback tests flip FB_SCRAPER_ENABLED on AND inject a stub fetch.
      FB_SCRAPER_ENABLED: "0",
      FB_SCRAPER_DELAY_MS: "0",
      // Set to 0 so the per-handle sleep() in twitter-followers.ts resolves
      // immediately in tests, avoiding a 500ms-per-handle delay.
      TWITTER_FOLLOWER_SYNC_DELAY_MS: "0",
    },
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
