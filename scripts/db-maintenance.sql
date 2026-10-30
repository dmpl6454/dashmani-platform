-- ============================================================================
-- scripts/db-maintenance.sql — table settings that live on the production database but NOT in
-- schema.prisma (Prisma has no way to express them, and `prisma migrate diff` ignores them).
-- Re-apply after a restore or a rebuild of the database. Safe to re-run.
--
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/db-maintenance.sql
--
-- api_usage (2026-10-31): the nightly rollup (api-usage-rollup.service.ts) deletes ~50k
-- per-call rows a day. Postgres's default autovacuum waits for 20% of a table to be dead —
-- 1.2M rows here — so the freed space sat unusable for weeks while new rows took fresh pages
-- (942k dead rows, never vacuumed). Vacuum after ~1% (≈70k rows ≈ daily) instead.
-- ============================================================================
ALTER TABLE api_usage SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_analyze_scale_factor = 0.02
);
