-- ============================================================================
-- scripts/pipeline-work2-ddl.sql — feature-only DDL: Pipeline work tracking, part 2 (2026-11-02).
--   pipeline_versions          + source, rights, licence_expires, embargo_until, usage_notes,
--                              file_key (unique), file_name, file_size, file_type (R2 uploads)
--   pipeline_version_comments  review comments on a version, optionally at a point in the video
--   pipeline_shoots            the shoot desk (paparazzi / event assignments)
-- Service: apps/api/src/services/pipeline/work.service.ts, shoots.service.ts
--
-- Generated with prisma migrate diff from the previous schema.prisma to this one, then
-- hand-edited like the other feature DDL scripts: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE TABLE / CREATE INDEX
-- IF NOT EXISTS, foreign keys guarded by a pg_constraint lookup. Definitions are
-- byte-identical to the generated output.
--
-- Purely additive. pipeline_versions is a new, small table (2026-11-02), so adding columns
-- with constant defaults is instant. No foreign key into users. Safe to re-run.
-- Apply on prod with scripts/apply-pipeline-work2-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "embargo_until" TIMESTAMP(3);
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "licence_expires" DATE;
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "rights" VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "source" VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "usage_notes" VARCHAR(1000) NOT NULL DEFAULT '';
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "file_key" VARCHAR(120);
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "file_name" VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "file_size" BIGINT;
ALTER TABLE "pipeline_versions" ADD COLUMN IF NOT EXISTS "file_type" VARCHAR(100) NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_version_comments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "at_seconds" INTEGER,
    "body" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_version_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_shoots" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "title" VARCHAR(120) NOT NULL,
    "event" VARCHAR(200) NOT NULL DEFAULT '',
    "location" VARCHAR(200) NOT NULL DEFAULT '',
    "call_time" TIMESTAMP(3) NOT NULL,
    "camera_id" TEXT,
    "contact" VARCHAR(200) NOT NULL DEFAULT '',
    "requirements" TEXT NOT NULL DEFAULT '',
    "deadline" TIMESTAMP(3),
    "embargo_until" TIMESTAMP(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'assigned',
    "upload_url" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_shoots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_versions_file_key_key" ON "pipeline_versions"("file_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_version_comments_version_id_created_at_idx" ON "pipeline_version_comments"("version_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_version_comments_project_id_idx" ON "pipeline_version_comments"("project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_shoots_call_time_idx" ON "pipeline_shoots"("call_time");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_shoots_camera_id_status_idx" ON "pipeline_shoots"("camera_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_shoots_project_id_idx" ON "pipeline_shoots"("project_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_version_comments_project_id_fkey') THEN
    ALTER TABLE "pipeline_version_comments" ADD CONSTRAINT "pipeline_version_comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_version_comments_version_id_fkey') THEN
    ALTER TABLE "pipeline_version_comments" ADD CONSTRAINT "pipeline_version_comments_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "pipeline_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_shoots_project_id_fkey') THEN
    ALTER TABLE "pipeline_shoots" ADD CONSTRAINT "pipeline_shoots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;


COMMIT;
