-- ============================================================================
-- scripts/link-metrics-catchup.sql — one-time catch-up of the link_metrics retention backlog
-- (2026-11-02, ~14M expired rows). Run by scripts/compact-usage-tables.sh; safe to re-run.
--
-- SAME RULE as link-metrics-retention.service.ts — a row goes only when it is older than 30
-- days, has a link_id, is not its link's newest row, and is not its link's newest ok row — but
-- evaluated against a per-link summary built in ONE sequential pass, instead of two index
-- probes per row (measured 35 s per 2000 blocks of cold history ≈ 3 h for the table).
--
-- The summary is a snapshot. Rows written after it are newer, so they only make it more
-- conservative; a row whose link_id is nulled or re-healed meanwhile fails the join or is
-- judged against an older maximum — never the row the maximum came from.
--
-- Each generated DELETE (2000 heap blocks, ctid range) runs as its own autocommit transaction
-- via \gexec: no long transaction, nothing for vacuum to wait on, and an interrupted run simply
-- leaves the rest for a re-run or the nightly job.
-- ============================================================================
\set ON_ERROR_STOP on
SET lock_timeout = '3s';
SET statement_timeout = '10min';
SET search_path = public;
\timing on

CREATE TEMP TABLE lm_marks AS
SELECT link_id,
       max(fetched_at)                               AS newest,
       max(fetched_at) FILTER (WHERE status = 'ok')  AS newest_ok
  FROM link_metrics
 WHERE link_id IS NOT NULL
 GROUP BY link_id;
CREATE UNIQUE INDEX ON lm_marks (link_id);
ANALYZE lm_marks;
SELECT count(*) AS links_summarised FROM lm_marks;

SET statement_timeout = '120s';
\timing off
SELECT format(
  $q$DELETE FROM link_metrics m USING lm_marks t
      WHERE m.ctid >= '(%s,0)'::tid AND m.ctid < '(%s,0)'::tid
        AND m.link_id = t.link_id
        AND m.fetched_at < (now() AT TIME ZONE 'UTC') - interval '30 days'
        AND m.fetched_at < t.newest
        AND (m.status <> 'ok' OR m.fetched_at < t.newest_ok)$q$,
  b, b + 2000)
  FROM generate_series(0, (pg_relation_size('link_metrics') / current_setting('block_size')::int)::int, 2000) AS b
\gexec

SELECT count(*) AS rows_left FROM link_metrics;
