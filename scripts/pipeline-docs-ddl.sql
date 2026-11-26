-- ============================================================================
-- scripts/pipeline-docs-ddl.sql — feature-only DDL: Pipeline project documents (2026-11-20).
--   pipeline_documents   pitch deck / brief / quote / report on a project: a link or an
--                        uploaded R2 file, with a status (draft → sent → accepted | rejected);
--                        also every file attached in chat (source 'chat', conversation_id)
--   pipeline_projects    + status_note, status_note_at, status_note_by_id (board card note)
--   pipeline_activity    the project activity timeline (append-only, separate from the chat)
-- Service: apps/api/src/services/pipeline/documents.service.ts
--
-- Generated with prisma migrate diff from main's schema.prisma to this one, then hand-edited
-- like the other feature DDL scripts: one transaction, lock_timeout 3s, statement_timeout 60s,
-- search_path pinned, CREATE TABLE / CREATE INDEX IF NOT EXISTS, the foreign key guarded by a
-- pg_constraint lookup. Definitions are byte-identical to the generated output.
--
-- Purely additive: two new tables (pipeline_documents, pipeline_activity), their FKs into
-- pipeline_projects (ON DELETE CASCADE), three new pipeline_projects columns, and one new index on
-- the existing pipeline_deliverables (scheduled_at). The FK
-- takes a brief SHARE ROW EXCLUSIVE lock on pipeline_projects; lock_timeout 3s bounds it.
-- No foreign key into users. Safe to re-run.
-- Apply on prod with scripts/apply-pipeline-docs-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable (2026-11-23): the owner's one-line "current status" note on the board card.
-- ADD COLUMN with a constant default is a catalog-only change on PG 11+ (no table rewrite); the
-- brief ACCESS EXCLUSIVE lock on pipeline_projects is bounded by lock_timeout 3s.
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "status_note" VARCHAR(140) NOT NULL DEFAULT '';
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "status_note_at" TIMESTAMP(3);
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "status_note_by_id" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "url" TEXT,
    "file_key" VARCHAR(120),
    "file_name" VARCHAR(200) NOT NULL DEFAULT '',
    "file_size" BIGINT,
    "file_type" VARCHAR(100) NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_by_id" TEXT NOT NULL,
    "note" VARCHAR(1000) NOT NULL DEFAULT '',
    "source" VARCHAR(8) NOT NULL DEFAULT 'tab',
    "conversation_id" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable (2026-11-24): the project activity timeline.
CREATE TABLE IF NOT EXISTS "pipeline_activity" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "actor_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_activity_project_id_created_at_idx" ON "pipeline_activity"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_file_key_key" ON "pipeline_documents"("file_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_documents_project_id_created_at_idx" ON "pipeline_documents"("project_id", "created_at");

-- CreateIndex (2026-11-24): the Dashboard's "waiting on client" (status = 'sent').
CREATE INDEX IF NOT EXISTS "pipeline_documents_status_status_changed_at_idx" ON "pipeline_documents"("status", "status_changed_at");

-- CreateIndex (2026-11-24): the Dashboard's "this week" pages. pipeline_deliverables is an EXISTING
-- table: CREATE INDEX holds a SHARE lock (writes to it wait, reads don't) for as long as the build
-- takes — milliseconds at its size; lock_timeout 3s bounds the wait for the lock itself.
CREATE INDEX IF NOT EXISTS "pipeline_deliverables_scheduled_at_idx" ON "pipeline_deliverables"("scheduled_at");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_activity_project_id_fkey') THEN
    ALTER TABLE "pipeline_activity" ADD CONSTRAINT "pipeline_activity_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_documents_project_id_fkey') THEN
    ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;


COMMIT;
