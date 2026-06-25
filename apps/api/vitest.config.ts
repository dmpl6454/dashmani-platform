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
    },
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
