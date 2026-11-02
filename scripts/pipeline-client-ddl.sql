-- ============================================================================
-- scripts/pipeline-client-ddl.sql — feature-only DDL: a Pipeline project can name the client
-- company it is for (2026-11-02).
-- Model:    PipelineProject (+linkedClientId → clients, ON DELETE SET NULL)
-- Services: apps/api/src/services/pipeline/projects.service.ts, sales/clients.service.ts
--
-- ⚠️ NOT `client_id` — that column already exists and is the create idempotency key.
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like the other feature DDL scripts: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE INDEX IF NOT EXISTS, the
-- foreign key guarded by a pg_constraint lookup. Definitions are byte-identical to the
-- generated output. pipeline_projects is small (one row per project), so a plain index build
-- inside the transaction takes milliseconds.
--
-- Purely additive: one nullable column, one index, one foreign key. Safe to re-run.
-- Apply on prod with scripts/apply-pipeline-client-ddl.sh BEFORE merging the PR (Pipeline DDL
-- cycle: docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "linked_client_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_linked_client_id_idx" ON "pipeline_projects"("linked_client_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_linked_client_id_fkey') THEN
    ALTER TABLE "pipeline_projects" ADD CONSTRAINT "pipeline_projects_linked_client_id_fkey" FOREIGN KEY ("linked_client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
