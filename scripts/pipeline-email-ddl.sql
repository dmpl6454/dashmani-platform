-- ============================================================================
-- scripts/pipeline-email-ddl.sql — feature-only DDL for the Pipeline EMAIL outbox.
-- Runbook: docs/superpowers/plans/2026-09-30-pipeline-email-runbook.md
-- Model:   PipelineEmailOutbox in packages/db/prisma/schema.prisma
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited exactly like scripts/pipeline-ddl.sql:
--   * one transaction, lock_timeout 3s, statement_timeout 60s, search_path pinned to public;
--   * CREATE ... IF NOT EXISTS, every FK behind a guard scoped to its own table (conname
--     AND conrelid);
--   * PLUS the partial unique index "pipeline_email_outbox_pending_key", which Prisma 5
--     cannot express. Prisma's introspection ignores partial indexes (verified on 5.22:
--     `migrate diff` stays empty, `db push` leaves the index alone), so after this runs
--     `prisma migrate diff --from-url <db> --to-schema-datamodel ... --exit-code` is 0.
-- The table, column and other index definitions are byte-identical to the generated output.
--
-- Safe to run twice: the second run changes nothing and raises no error. It is fast on a
-- live system (the table is new and small), but a re-run still takes brief locks: each
-- CREATE INDEX IF NOT EXISTS takes a SHARE lock on the (small) outbox table, and the FK
-- guards run only when the constraint is missing.
-- Touches ONLY the new pipeline_email_outbox table. No existing table gets DDL.
--
-- LOCKS. Adding the two FKs takes a brief SHARE ROW EXCLUSIVE lock on the referenced
-- tables until COMMIT: "pipeline_projects" (blocks pipeline writes for milliseconds) and
-- "users" (blocks writes to users, not reads such as login). They are placed LAST, users
-- very last, so each lock is held for milliseconds. If a lock is not granted within 3s the
-- whole script aborts and rolls back; retry later.
--
-- Apply ONLY through psql:  psql -v ON_ERROR_STOP=1 -f scripts/pipeline-email-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
-- Every name below is unqualified and psql's default search_path is "$user", public: a
-- schema named after the app role would otherwise receive the table. Prisma uses public.
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_email_outbox" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "send_after" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the worker's claim (status = 'pending' AND send_after <= now ORDER BY
-- send_after), the stale-'sending' recovery and the 30-day trim.
CREATE INDEX IF NOT EXISTS "pipeline_email_outbox_status_send_after_idx" ON "pipeline_email_outbox"("status", "send_after");

-- CreateIndex — the FK cascade when the purge deletes a project must not full-scan.
CREATE INDEX IF NOT EXISTS "pipeline_email_outbox_project_id_idx" ON "pipeline_email_outbox"("project_id");

-- The coalescing key (hand-written; see the header). A burst of events for one recipient,
-- project and kind upserts ONE pending row through
--   INSERT ... ON CONFLICT ("user_id", "project_id", "kind") WHERE "status" = 'pending' DO UPDATE
-- The API's schema self-check EXPLAINs exactly that clause; without this index the email
-- feature stays off (it never makes an action's transaction fail).
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_email_outbox_pending_key" ON "pipeline_email_outbox"("user_id", "project_id", "kind") WHERE "status" = 'pending';

-- AddForeignKey (-> "pipeline_projects"): SHARE ROW EXCLUSIVE on pipeline_projects until COMMIT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_email_outbox_project_id_fkey' AND conrelid = '"public"."pipeline_email_outbox"'::regclass) THEN
    ALTER TABLE "pipeline_email_outbox" ADD CONSTRAINT "pipeline_email_outbox_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (-> "users"). LAST on purpose: the SHARE ROW EXCLUSIVE lock on "users"
-- described in the header is held from here until COMMIT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_email_outbox_user_id_fkey' AND conrelid = '"public"."pipeline_email_outbox"'::regclass) THEN
    ALTER TABLE "pipeline_email_outbox" ADD CONSTRAINT "pipeline_email_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
