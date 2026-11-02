-- ============================================================================
-- scripts/pipeline-email-work-ddl.sql — emails for Pipeline work notices (2026-11-02).
-- Model: PipelineEmailOutbox in packages/db/prisma/schema.prisma (projectId is now optional).
--
-- A "shoot" email may belong to a shoot with NO project, so pipeline_email_outbox.project_id
-- becomes nullable. Nothing else changes: the foreign key (ON DELETE CASCADE) and the partial
-- unique index (user_id, project_id, kind) WHERE status = 'pending' stay as they are — a row
-- with a NULL project never conflicts, so each standalone shoot email is its own row.
--
-- One statement, metadata-only (no table rewrite). It takes an ACCESS EXCLUSIVE lock on the
-- small outbox table for milliseconds; if not granted within 3 s it aborts and rolls back.
-- Safe to run twice: DROP NOT NULL on a nullable column is a no-op.
--
-- Apply ONLY through psql (scripts/apply-pipeline-email-work-ddl.sh on the box).
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE "pipeline_email_outbox" ALTER COLUMN "project_id" DROP NOT NULL;

COMMIT;
