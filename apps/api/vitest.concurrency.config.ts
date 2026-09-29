import { configDefaults, defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Pipeline concurrency suite (P8; spec §11): tests-concurrency/** ONLY.
 *
 *   cd apps/api && DATABASE_URL="postgresql://user:password@localhost:5432/dashmani_pipeline_cc?connection_limit=10" \
 *     PIPELINE_DB_CONNECTIONS=3 npx vitest run -c vitest.concurrency.config.ts
 *
 * Derived from vitest.config.ts rather than copied, so the safety env block there (the FB
 * scraper kill switch, zeroed sleeps, the dummy token key) can never drift out of this one.
 * What differs:
 * - include: only tests-concurrency/ (which the main config excludes);
 * - PIPELINE_DB_CONNECTIONS defaults to 3 (the production pipeline pool), not 1 — the
 *   main suite's single connection cannot show real interleaving;
 * - it keeps pool: "forks" + singleFork: true and tests/setup.ts, so files never run in
 *   parallel against the one database and every test starts from a TRUNCATEd state.
 *
 * ⚠️ Run it against its OWN database (CI: dashmani_pipeline_cc) — tests/setup.ts
 * TRUNCATEs whatever DATABASE_URL points at.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests-concurrency/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    env: {
      ...base.test?.env,
      PIPELINE_DB_CONNECTIONS: process.env.PIPELINE_DB_CONNECTIONS || "3",
    },
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
