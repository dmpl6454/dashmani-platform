-- ============================================================================
-- scripts/pipeline-work-ddl.sql — feature-only DDL: Pipeline work tracking (2026-11-02).
-- Models:   PipelineVersion, PipelineReview, PipelineDeliverable (each → pipeline_projects,
--           ON DELETE CASCADE)
-- Service:  apps/api/src/services/pipeline/work.service.ts
--
--   pipeline_versions      video v1, v2…, caption v1…, thumbnail v1… — links, never uploads
--   pipeline_reviews       a review request pinned to the versions it was made for
--   pipeline_deliverables  one publishing record per destination page
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like the other feature DDL scripts: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE TABLE / CREATE INDEX IF NOT EXISTS, the
-- foreign keys guarded by a pg_constraint lookup. Definitions are byte-identical to the
-- generated output.
--
-- Purely additive: three new tables. No foreign key into `users` (that would lock a hot table);
-- the only foreign keys point at pipeline_projects, which is small. Safe to re-run.
-- Apply on prod with scripts/apply-pipeline-work-ddl.sh BEFORE merging the PR (Pipeline DDL
-- cycle: docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "number" INTEGER NOT NULL,
    "label" VARCHAR(120) NOT NULL DEFAULT '',
    "url" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "note" VARCHAR(500) NOT NULL DEFAULT '',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_reviews" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "version_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "note" VARCHAR(2000) NOT NULL DEFAULT '',
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_deliverables" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "destination" VARCHAR(120) NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "scheduled_at" TIMESTAMP(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "assignee_id" TEXT,
    "live_url" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "approved_review_id" TEXT,
    "note" VARCHAR(500) NOT NULL DEFAULT '',
    "rev" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_versions_project_id_kind_number_key" ON "pipeline_versions"("project_id", "kind", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_reviews_project_id_created_at_idx" ON "pipeline_reviews"("project_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_reviews_reviewer_id_status_idx" ON "pipeline_reviews"("reviewer_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_deliverables_project_id_idx" ON "pipeline_deliverables"("project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_deliverables_assignee_id_status_idx" ON "pipeline_deliverables"("assignee_id", "status");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_versions_project_id_fkey') THEN
    ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_reviews_project_id_fkey') THEN
    ALTER TABLE "pipeline_reviews" ADD CONSTRAINT "pipeline_reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_deliverables_project_id_fkey') THEN
    ALTER TABLE "pipeline_deliverables" ADD CONSTRAINT "pipeline_deliverables_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;


COMMIT;
