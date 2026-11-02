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

-- link_metrics (2026-11-02): the nightly retention (link-metrics-retention.service.ts) deletes a
-- day's worth of expired snapshots at a time. Vacuum after ~2% so the space is reused promptly
-- instead of waiting for 20% of the table to be dead.
ALTER TABLE link_metrics SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_analyze_scale_factor = 0.05
);
