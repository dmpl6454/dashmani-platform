/**
 * The pipeline concurrency suite (spec §11 "Concurrency suite", plan Task 12.1).
 *
 *   cd apps/api && DATABASE_URL="postgresql://user:password@localhost:5432/dashmani_pipeline_cc?connection_limit=10" \
 *     PIPELINE_DB_CONNECTIONS=3 npx vitest run -c vitest.concurrency.config.ts
 *
 * ⚠️ Unlike vitest.config.ts this config does NOT read the repo-root .env: that file
 * points at the owner's dev database, and tests/setup.ts TRUNCATEs every table in
 * beforeEach. DATABASE_URL must be exported explicitly and must name a database other
 * than the dev one — otherwise the config refuses to start.
 *
 * The pipeline pool runs at its production size (3) so the races are real, and the
 * pipeline + global rate limits are raised so a 20 ms poller measures the protocol, not
 * the limiter (bucket isolation has its own tests in the main suite).
 */
import { defineConfig } from "vitest/config";

const url = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  const u = new URL(url);
  dbName = u.pathname.replace(/^\//, "");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(`refusing a non-localhost DATABASE_URL (${u.hostname})`);
  }
} catch (err) {
  throw new Error(`vitest.concurrency.config: set DATABASE_URL to a local scratch database (${String(err)})`);
}
if (!dbName || dbName === "dashmani") {
  throw new Error("vitest.concurrency.config: refusing the dev database 'dashmani' — use e.g. dashmani_pipeline_cc");
}

export default defineConfig({
  test: {
    include: ["tests-concurrency/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      PIPELINE_DB_CONNECTIONS: process.env.PIPELINE_DB_CONNECTIONS || "3",
      PIPELINE_RATE_READ_MAX: "1000000",
      PIPELINE_RATE_WRITE_MAX: "1000000",
      PIPELINE_RATE_MSG_MAX: "1000000",
      RATE_LIMIT_MAX: "1000000",
      JWT_SECRET: process.env.JWT_SECRET || "cc-test-secret",
      META_TOKEN_ENC_KEY: "test-only-meta-token-encryption-key-do-not-ship",
    },
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
